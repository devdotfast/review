import { describe, expect, it } from "vitest";

import { collapseInlineC4Node, projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";

function createProjectionModel() {
  return defineSoftwareModel({
    people: {
      reviewer: { label: "Reviewer" },
    },
    systems: {
      product: {
        label: "Product",
        containers: {
          web: {
            label: "Web",
            components: {
              ui: {
                label: "UI",
                codeElements: {
                  render: {
                    label: "render",
                    sourceRanges: [
                      { file: "src/example.ts", fromLine: 1, toLine: 1 },
                    ],
                  },
                  hydrate: {
                    label: "hydrate",
                    sourceRanges: [
                      { file: "src/example.ts", fromLine: 1, toLine: 1 },
                    ],
                  },
                },
              },
            },
          },
          api: {
            label: "API",
            components: {
              handler: {
                label: "Handler",
                codeElements: {
                  route: {
                    label: "route",
                    sourceRanges: [
                      { file: "src/example.ts", fromLine: 1, toLine: 1 },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      telemetry: {
        label: "Telemetry",
        containers: {
          ingest: {},
        },
      },
    },
    relationships: [
      {
        kind: "semantic",
        from: "reviewer",
        to: "product.web.ui",
        label: "reviews",
      },
      {
        kind: "call",
        from: "product.web.ui.render",
        to: "product.api.handler.route",
      },
      {
        kind: "semantic",
        semanticKind: "publishes",
        from: "product.web.ui.render",
        to: "telemetry.ingest",
      },
      {
        kind: "semantic",
        semanticKind: "publishes",
        from: "product.web.ui.hydrate",
        to: "telemetry.ingest",
      },
      {
        kind: "semantic",
        semanticKind: "observes",
        from: "product.web.ui.hydrate",
        to: "telemetry.ingest",
      },
    ],
  });
}

describe("projectInlineC4", () => {
  it("starts with top-level people and software systems", () => {
    const model = createProjectionModel();

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(),
      selectedNodeId: "product",
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "reviewer",
      "product",
      "telemetry",
    ]);
    expect(
      projection.nodes.map((node) => ({
        path: node.path,
        isExpandable: node.isExpandable,
        isExpanded: node.isExpanded,
        isSelected: node.isSelected,
      })),
    ).toEqual([
      {
        path: "reviewer",
        isExpandable: false,
        isExpanded: false,
        isSelected: false,
      },
      {
        path: "product",
        isExpandable: true,
        isExpanded: false,
        isSelected: true,
      },
      {
        path: "telemetry",
        isExpandable: true,
        isExpanded: false,
        isSelected: false,
      },
    ]);
    expect(
      projection.relationships.map((relationship) => ({
        kind: relationship.kind,
        from: relationship.from,
        to: relationship.to,
        count: relationship.count,
      })),
    ).toEqual([
      {
        kind: "semantic",
        from: "reviewer",
        to: "product",
        count: 1,
      },
      {
        kind: "semantic",
        from: "product",
        to: "telemetry",
        count: 3,
      },
    ]);
  });

  it("reveals expanded children recursively", () => {
    const model = createProjectionModel();

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.web", "product.web.ui"]),
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "reviewer",
      "product",
      "product.web",
      "product.web.ui",
      "product.web.ui.render",
      "product.web.ui.hydrate",
      "product.api",
      "telemetry",
    ]);
    expect(
      projection.nodes
        .filter((node) => node.isExpanded)
        .map((node) => node.path),
    ).toEqual(["product", "product.web", "product.web.ui"]);
    expect(
      projection.nodes.find((node) => node.path === "product")?.children,
    ).toEqual(["product.web", "product.api"]);
    expect(
      projection.nodes.find((node) => node.path === "product.web.ui")?.children,
    ).toEqual(["product.web.ui.render", "product.web.ui.hydrate"]);
  });

  it("projects data stores as system children beside containers", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            api: {
              components: {
                writer: {
                  codeElements: {
                    save: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
          dataStores: {
            database: {
              kind: "objectStore",
              label: "Review DB",
              components: {
                schema: {
                  codeElements: {
                    migrate: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "product.api.writer.save",
          to: "product.database.schema.migrate",
          label: "persists",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
    });

    expect(
      projection.nodes.map((node) => ({
        path: node.path,
        type: node.type,
        dataStoreKind: node.dataStoreKind,
      })),
    ).toEqual([
      { path: "product", type: "softwareSystem", dataStoreKind: undefined },
      { path: "product.api", type: "container", dataStoreKind: undefined },
      {
        path: "product.database",
        type: "dataStore",
        dataStoreKind: "objectStore",
      },
    ]);
    expect(projection.relationships).toContainEqual(
      expect.objectContaining({
        from: "product.api",
        to: "product.database",
        label: "persists",
      }),
    );
  });

  it("expands map-authored data store schema as C4 child nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            emitter: {
              components: {
                writer: {},
              },
            },
          },
          dataStores: {
            graphDb: {
              kind: "database",
              label: "Graph SQLite database",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    source_file: { type: "text", fk: "source_files.path" },
                  },
                },
                source_files: {
                  schema: {
                    path: { type: "text", pk: true },
                  },
                },
                edges: {
                  schema: {
                    id: { type: "text", pk: true },
                    from_id: { type: "text", fk: "nodes.id" },
                    to_id: { type: "text", fk: "nodes.id" },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          semanticKind: "writes",
          from: "product.emitter.writer",
          to: "product.graphDb.tables.nodes.id",
          label: "writes nodes",
        },
      ],
    });

    const collapsed = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
    }).nodes.find((node) => node.path === "product.graphDb");
    const expanded = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.graphDb"]),
    }).nodes.find((node) => node.path === "product.graphDb");

    expect(collapsed).toMatchObject({
      isExpandable: true,
      childCount: 3,
      dataStoreSchemaSections: undefined,
    });
    expect(expanded?.children).toEqual([
      "product.graphDb.tables.nodes",
      "product.graphDb.tables.source_files",
      "product.graphDb.tables.edges",
    ]);
    expect(expanded?.dataStoreSchemaSections).toBeUndefined();
    expect(
      projectInlineC4({
        model,
        expandedNodeIds: new Set(["product", "product.graphDb"]),
      }).nodes.map((node) => ({
        path: node.path,
        parentPath: node.parentPath,
        type: node.type,
        dataStoreSchemaSections: node.dataStoreSchemaSections,
      })),
    ).toContainEqual({
      path: "product.graphDb.tables.nodes",
      parentPath: "product.graphDb",
      type: "dataStoreCollection",
      dataStoreSchemaSections: [
        {
          id: "table:nodes",
          kind: "table",
          label: "nodes",
          rows: [
            {
              id: "nodes:id",
              label: "id",
              depth: 0,
              type: "text",
              primaryKey: true,
              foreignKey: false,
            },
            {
              id: "nodes:source_file",
              label: "source_file",
              depth: 0,
              type: "text",
              primaryKey: undefined,
              foreignKey: true,
            },
          ],
        },
      ],
    });
  });

  it("projects table foreign keys and schema relationships to expanded table nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            emitter: {
              components: {
                writer: {},
              },
            },
          },
          dataStores: {
            graphDb: {
              kind: "database",
              label: "Graph SQLite database",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    source_file: { type: "text", fk: "source_files.path" },
                  },
                },
                source_files: {
                  schema: {
                    path: { type: "text", pk: true },
                  },
                },
                edges: {
                  schema: {
                    id: { type: "text", pk: true },
                    from_id: { type: "text", fk: "nodes.id" },
                    to_id: { type: "text", fk: "nodes.id" },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          semanticKind: "writes",
          from: "product.emitter.writer",
          to: "product.graphDb.tables.nodes.id",
          label: "writes nodes",
        },
      ],
    });

    const collapsed = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.emitter"]),
    });
    expect(collapsed.relationships).toContainEqual(
      expect.objectContaining({
        from: "product.emitter.writer",
        to: "product.graphDb",
        label: "writes nodes",
      }),
    );
    expect(
      collapsed.relationships.some((relationship) =>
        relationship.id.startsWith("schema-fk:"),
      ),
    ).toBe(false);

    const expanded = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "product",
        "product.emitter",
        "product.graphDb",
      ]),
    });

    expect(expanded.relationships).toContainEqual(
      expect.objectContaining({
        from: "product.emitter.writer",
        to: "product.graphDb.tables.nodes",
        label: "writes nodes",
        toSchemaFieldPath: ["id"],
        toSchemaEndpointKind: "field",
      }),
    );
    expect(expanded.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "schema-fk:product.graphDb.tables.nodes.source_file->product.graphDb.tables.source_files.path",
          from: "product.graphDb.tables.nodes",
          to: "product.graphDb.tables.source_files",
          semanticKind: "foreign key",
          hideLabel: true,
          fromSchemaFieldPath: ["source_file"],
          fromSchemaEndpointKind: "field",
          toSchemaFieldPath: [],
          toSchemaEndpointKind: "header",
        }),
        expect.objectContaining({
          id: "schema-fk:product.graphDb.tables.edges.from_id->product.graphDb.tables.nodes.id",
          from: "product.graphDb.tables.edges",
          to: "product.graphDb.tables.nodes",
          semanticKind: "foreign key",
          hideLabel: true,
          fromSchemaFieldPath: ["from_id"],
          fromSchemaEndpointKind: "field",
          toSchemaFieldPath: [],
          toSchemaEndpointKind: "header",
        }),
      ]),
    );
  });

  it("keeps document schema as data store collection nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            artifactStore: {
              kind: "artifactStore",
              documents: {
                review: {
                  key: "path",
                  schema: {
                    path: { type: "text", pk: true },
                    body: { type: "mdx" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.artifactStore"]),
    });

    expect(projection.nodes).toContainEqual(
      expect.objectContaining({
        path: "product.artifactStore.documents.review",
        type: "dataStoreCollection",
        parentPath: "product.artifactStore",
        dataStoreSchemaSections: [
          {
            id: "document:review",
            kind: "document",
            label: "review",
            key: "path",
            rows: [
              {
                id: "review:path",
                label: "path",
                depth: 0,
                type: "text",
                primaryKey: true,
                foreignKey: false,
              },
              {
                id: "review:body",
                label: "body",
                depth: 0,
                type: "mdx",
                primaryKey: undefined,
                foreignKey: false,
              },
            ],
          },
        ],
      }),
    );
  });

  it("retargets relationships to one-side and both-side visible endpoints", () => {
    const model = createProjectionModel();

    const oneSideProjection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.web"]),
    });
    expect(
      oneSideProjection.relationships.find(
        (relationship) => relationship.kind === "call",
      ),
    ).toMatchObject({
      from: "product.web.ui",
      to: "product.api",
      sourceRelationshipIds: ["model.relationship.1"],
      count: 1,
    });

    const bothSidesProjection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "product",
        "product.web",
        "product.api",
        "product.api.handler",
      ]),
    });
    expect(
      bothSidesProjection.relationships.find(
        (relationship) => relationship.kind === "call",
      ),
    ).toMatchObject({
      from: "product.web.ui",
      to: "product.api.handler.route",
      sourceRelationshipIds: ["model.relationship.1"],
      count: 1,
    });
  });

  it("treats code elements as terminal nodes", () => {
    const model = createProjectionModel();

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "product",
        "product.web",
        "product.web.ui",
        "product.web.ui.render",
      ]),
    });

    const renderNode = projection.nodes.find(
      (node) => node.path === "product.web.ui.render",
    );
    expect(renderNode).toMatchObject({
      isExpandable: false,
      isExpanded: false,
      children: [],
      childCount: 0,
    });
    expect([...projection.expandedNodeIds]).toEqual([
      "product",
      "product.web",
      "product.web.ui",
    ]);
  });

  it("aggregates projected relationships by endpoints and kind", () => {
    const model = createProjectionModel();

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.web"]),
    });

    expect(
      projection.relationships.map((relationship) => ({
        kind: relationship.kind,
        semanticKind: relationship.semanticKind,
        from: relationship.from,
        to: relationship.to,
        sourceRelationshipIds: relationship.sourceRelationshipIds,
        count: relationship.count,
      })),
    ).toEqual([
      {
        kind: "semantic",
        semanticKind: undefined,
        from: "reviewer",
        to: "product.web.ui",
        sourceRelationshipIds: ["model.relationship.0"],
        count: 1,
      },
      {
        kind: "call",
        semanticKind: undefined,
        from: "product.web.ui",
        to: "product.api",
        sourceRelationshipIds: ["model.relationship.1"],
        count: 1,
      },
      {
        kind: "semantic",
        semanticKind: undefined,
        from: "product.web.ui",
        to: "telemetry",
        sourceRelationshipIds: [
          "model.relationship.2",
          "model.relationship.3",
          "model.relationship.4",
        ],
        count: 3,
      },
    ]);
  });

  it("aggregates mixed graph relationships once they project to component endpoints", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            web: {
              components: {
                shell: {
                  label: "Review shell",
                  codeElements: {
                    ReviewLayout: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
                files: {
                  label: "File diff view",
                  codeElements: {
                    FilesDiffView: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "call",
          from: "product.web.shell.ReviewLayout",
          to: "product.web.files.FilesDiffView",
        },
        {
          kind: "semantic",
          semanticKind: "render_composition",
          from: "product.web.shell.ReviewLayout",
          to: "product.web.files.FilesDiffView",
          label: "renders",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.web"]),
    });

    expect(
      projection.relationships.map((relationship) => ({
        from: relationship.from,
        to: relationship.to,
        sourceRelationshipIds: relationship.sourceRelationshipIds,
        count: relationship.count,
      })),
    ).toEqual([
      {
        from: "product.web.shell",
        to: "product.web.files",
        sourceRelationshipIds: ["model.relationship.0", "model.relationship.1"],
        count: 2,
      },
    ]);
  });

  it("filters inline C4 projections to changed nodes only", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            web: {
              changeStatus: "unchanged",
              components: {
                renderer: {
                  changeStatus: "modified",
                  label: "Renderer",
                },
                shell: {
                  changeStatus: "unchanged",
                  label: "Shell",
                },
              },
            },
            api: {
              changeStatus: "added",
              label: "API",
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "product.web.renderer",
          to: "product.api",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.web"]),
      modifiedOnly: true,
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "product",
      "product.web.renderer",
      "product.api",
    ]);
    expect(
      projection.relationships.map(({ from, to }) => ({ from, to })),
    ).toEqual([
      {
        from: "product.web.renderer",
        to: "product.api",
      },
    ]);
  });

  it("keeps modified-only filtering scoped to the current inline C4 level", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          label: "Product",
          containers: {
            web: {
              label: "Web",
              components: {
                renderer: { label: "Renderer" },
                shell: { label: "Shell" },
              },
            },
            worker: {
              label: "Worker",
              components: {
                queue: { label: "Queue" },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "product.web.renderer",
          to: "product.worker.queue",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
      modifiedOnly: true,
      changedNodeIds: new Set([
        "product",
        "product.web",
        "product.web.renderer",
        "product.worker",
        "product.worker.queue",
      ]),
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "product",
      "product.web",
      "product.worker",
    ]);
    expect(projection.relationships).toEqual([
      expect.objectContaining({
        from: "product.web",
        to: "product.worker",
      }),
    ]);
  });

  it("projects one implied edge through hidden unchanged nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            renderer: {
              changeStatus: "modified",
              label: "Renderer",
            },
            web: {
              changeStatus: "unchanged",
              label: "Web",
            },
            store: {
              changeStatus: "modified",
              label: "Comment Store",
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "product.renderer",
          to: "product.web",
        },
        {
          kind: "semantic",
          from: "product.web",
          to: "product.store",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
      modifiedOnly: true,
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "product",
      "product.renderer",
      "product.store",
    ]);
    expect(projection.relationships).toEqual([
      expect.objectContaining({
        id: "elided:product.renderer->product.store",
        kind: "implied",
        from: "product.renderer",
        to: "product.store",
        sourceRelationshipIds: ["model.relationship.0", "model.relationship.1"],
        hideLabel: true,
      }),
    ]);
  });

  it("does not imply an edge between fan-out siblings of a hidden source", () => {
    // C <- A -> B with A hidden: no DIRECTED path connects C and B, so no
    // implied edge may appear between them in either direction.
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            hub: {
              changeStatus: "unchanged",
              label: "Hub",
            },
            left: {
              changeStatus: "modified",
              label: "Left",
            },
            right: {
              changeStatus: "modified",
              label: "Right",
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "product.hub",
          to: "product.left",
        },
        {
          kind: "semantic",
          from: "product.hub",
          to: "product.right",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
      modifiedOnly: true,
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "product",
      "product.left",
      "product.right",
    ]);
    expect(projection.relationships).toEqual([]);
  });

  it("does not add an implied edge when a direct visible edge exists", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            renderer: { changeStatus: "modified" },
            web: { changeStatus: "unchanged" },
            store: { changeStatus: "modified" },
          },
        },
      },
      relationships: [
        { kind: "semantic", from: "product.renderer", to: "product.web" },
        { kind: "semantic", from: "product.web", to: "product.store" },
        {
          kind: "call",
          from: "product.renderer",
          to: "product.store",
          label: "writes directly",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
      modifiedOnly: true,
    });

    expect(projection.relationships).toEqual([
      expect.objectContaining({
        kind: "call",
        from: "product.renderer",
        to: "product.store",
      }),
    ]);
    expect(
      projection.relationships.some(
        (relationship) => relationship.kind === "implied",
      ),
    ).toBe(false);
  });

  it("keeps foreign-key edges when a changed data store is expanded in modified-only mode", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          dataStores: {
            graphDb: {
              kind: "database",
              label: "Graph DB",
              changeStatus: "modified",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    source_file: { type: "text", fk: "source_files.path" },
                  },
                },
                source_files: {
                  schema: { path: { type: "text", pk: true } },
                },
              },
            },
          },
        },
      },
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.graphDb"]),
      modifiedOnly: true,
    });

    expect(
      projection.nodes.map((node) => ({ path: node.path, type: node.type })),
    ).toEqual([
      { path: "product", type: "softwareSystem" },
      { path: "product.graphDb", type: "dataStore" },
      {
        path: "product.graphDb.tables.nodes",
        type: "dataStoreCollection",
      },
      {
        path: "product.graphDb.tables.source_files",
        type: "dataStoreCollection",
      },
    ]);
    expect(projection.relationships).toEqual([
      expect.objectContaining({
        id: "schema-fk:product.graphDb.tables.nodes.source_file->product.graphDb.tables.source_files.path",
        kind: "semantic",
        semanticKind: "foreign key",
        from: "product.graphDb.tables.nodes",
        to: "product.graphDb.tables.source_files",
        hideLabel: true,
        fromSchemaFieldPath: ["source_file"],
        fromSchemaEndpointKind: "field",
        toSchemaFieldPath: [],
        toSchemaEndpointKind: "header",
      }),
    ]);
    expect(
      projection.relationships.some(
        (relationship) => relationship.kind === "implied",
      ),
    ).toBe(false);
  });

  it("keeps schema-field relationships when a changed data store is expanded in modified-only mode", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            emitter: {
              changeStatus: "modified",
              components: { writer: {} },
            },
          },
          dataStores: {
            graphDb: {
              kind: "database",
              label: "Graph DB",
              changeStatus: "modified",
              tables: {
                nodes: { schema: { id: { type: "text", pk: true } } },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          semanticKind: "writes",
          from: "product.emitter.writer",
          to: "product.graphDb.tables.nodes.id",
          label: "writes nodes",
        },
      ],
    });

    const collapsed = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product"]),
      modifiedOnly: true,
    });
    expect(
      collapsed.relationships.map((r) => ({ from: r.from, to: r.to })),
    ).toEqual([{ from: "product.emitter", to: "product.graphDb" }]);

    const expanded = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.graphDb"]),
      modifiedOnly: true,
    });
    expect(
      expanded.relationships.map((r) => ({ from: r.from, to: r.to })),
    ).toEqual([
      { from: "product.emitter", to: "product.graphDb.tables.nodes" },
    ]);
    expect(expanded.relationships).toContainEqual(
      expect.objectContaining({
        from: "product.emitter",
        to: "product.graphDb.tables.nodes",
        toSchemaFieldPath: ["id"],
        toSchemaEndpointKind: "field",
      }),
    );
    expect(expanded.relationships.some((r) => r.kind === "implied")).toBe(
      false,
    );
  });

  it("does not seed collection nodes for an unchanged expanded data store in modified-only mode", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          changeStatus: "modified",
          containers: {
            emitter: {
              changeStatus: "modified",
              components: { writer: {} },
            },
          },
          dataStores: {
            graphDb: {
              kind: "database",
              label: "Graph DB",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    source_file: { type: "text", fk: "source_files.path" },
                  },
                },
                source_files: {
                  schema: { path: { type: "text", pk: true } },
                },
              },
            },
          },
        },
      },
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(["product", "product.graphDb"]),
      modifiedOnly: true,
    });

    expect(projection.nodes.map((node) => node.path)).toEqual([
      "product",
      "product.emitter",
    ]);
    expect(
      projection.nodes.some((node) => node.type === "dataStoreCollection"),
    ).toBe(false);
    expect(projection.relationships).toEqual([]);
  });
});

describe("collapseInlineC4Node", () => {
  it("removes the collapsed node and all expanded descendants", () => {
    expect([
      ...collapseInlineC4Node(
        new Set([
          "product",
          "product.web",
          "product.web.ui",
          "telemetry",
          "telemetry.ingest",
        ]),
        "product.web",
      ),
    ]).toEqual(["product", "telemetry", "telemetry.ingest"]);
  });
});
