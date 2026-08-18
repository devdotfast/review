import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  databaseC4Snapshot,
  databaseTourStopDetail,
  initialDatabaseC4ExpandedNodeIds,
  seedDatabaseC4DefaultExpandedNodeIds,
  selectDatabaseOperationHighlights,
} from "./database-lens";
import { createTestReviewDefinitionSession } from "./review-definition-test-utils";
import { defineSoftwareModel } from "./software-map/model";
import { c4LayoutSignature } from "./software-map/SoftwareMap";

const { defineSoftwareStores } = createTestReviewDefinitionSession();

describe("software map backed database lenses", () => {
  it("keeps the database diagram responsive inside review documents", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const mapStyles = readFileSync(
      new URL("./software-map/styles.css", import.meta.url),
      { encoding: "utf8" },
    );
    const source = readFileSync(
      new URL("./database-lens.tsx", import.meta.url),
      {
        encoding: "utf8",
      },
    );

    expect(styles).toMatch(
      /\.database-lens\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.database-lens-index\s*{[^}]*grid-template-columns:\s*minmax\(180px,\s*260px\)\s*minmax\(0,\s*1fr\);/s,
    );
    expect(
      source.indexOf('className="diagram-header database-lens-header"'),
    ).toBeLessThan(source.indexOf('className="database-lens-diagram"'));
    expect(styles).toMatch(
      /\.database-lens\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.database-lens-diagram\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*560px\)\s*{[\s\S]*?\.database-lens\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*560px\)\s*{[\s\S]*?\.database-lens-diagram\s*{[^}]*min-height:\s*520px;/s,
    );
    expect(source).toContain("<SoftwareMapFrame");
    expect(source).toContain("relationshipStateById={relationshipStateById}");
    expect(source).toContain("onOpenRelationship={openRelationship}");
    expect(source).toContain("dataStoreSchemaSections");
    expect(mapStyles).toMatch(
      /\.software-map-c4-edge-label,\s*\.software-map-c4-edge-label--active\s*{[^}]*padding:\s*4px 10px !important;[^}]*border:\s*1px solid var\(--map-line-2\) !important;[^}]*background:\s*var\(--map-chip\) !important;/s,
    );
    expect(mapStyles).toMatch(
      /\.software-map-c4-canvas \.react-flow__edge-path,\s*\.software-map-c4-canvas \.react-flow__edge\.selected \.react-flow__edge-path,\s*\.software-map-c4-edge--operation-active \.react-flow__edge-path\s*{[^}]*stroke:\s*var\(--map-edge\) !important;[^}]*stroke-width:\s*1\.5px !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-data-store-schema-row--active\s*{[^}]*outline:\s*2px solid var\(--selection\);/s,
    );
  });

  it("derives DatabaseLens stores from software map data stores", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            appDb: {
              label: "App database",
              kind: "database",
              tables: {
                reviews: {
                  schema: {
                    id: { type: "text", pk: true },
                    body: { type: "text" },
                  },
                },
              },
            },
            artifactStore: {
              label: "Review artifacts",
              kind: "artifactStore",
              documents: {
                softwareMap: {
                  schema: {
                    path: { type: "text", pk: true },
                  },
                },
              },
            },
            defaultDb: {
              label: "Default database",
            },
          },
        },
      },
    });

    const stores = defineSoftwareStores(model, {
      appDb: {
        path: "product.appDb",
      },
      artifacts: {
        path: "product.artifactStore",
      },
      defaultDb: {
        path: "product.defaultDb",
        tables: {
          sessions: {
            schema: {
              id: { type: "text", pk: true },
            },
          },
        },
      },
    });

    expect(stores.appDb).toMatchObject({
      id: "appDb",
      kind: "relational",
      label: "App database",
      dataStoreKind: "database",
      softwareMapPath: "product.appDb",
    });
    expect(stores.appDb.tables?.reviews.id).toMatchObject({
      storeDataStoreKind: "database",
      storeSoftwareMapPath: "product.appDb",
    });
    expect(stores.appDb.tables?.reviews.schema).toEqual({
      id: { type: "text", pk: true },
      body: { type: "text" },
    });
    expect(stores.artifacts).toMatchObject({
      id: "artifacts",
      kind: "document",
      label: "Review artifacts",
      dataStoreKind: "artifactStore",
      softwareMapPath: "product.artifactStore",
    });
    expect(stores.defaultDb).toMatchObject({
      id: "defaultDb",
      kind: "relational",
      label: "Default database",
      softwareMapPath: "product.defaultDb",
    });
  });

  it("keeps collection metadata renderable when table fields collide with id and label", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            graphDb: {
              label: "Graph database",
              kind: "database",
              tables: {
                nodes: {
                  label: "nodes",
                  schema: {
                    id: { type: "text", pk: true },
                    label: { type: "text" },
                    props_json: { type: "json" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const stores = defineSoftwareStores(model, {
      graphDb: { path: "product.graphDb" },
    });
    const fieldRef = stores.graphDb.tables?.nodes.label;
    expect(fieldRef).toMatchObject({
      __kind: "db-target-ref",
      path: ["label"],
    });

    const actor = {
      __kind: "db-actor-ref",
      id: "reader",
      label: "Reader",
    };
    const target = stores.graphDb.tables?.nodes.label;
    const snapshot = databaseC4Snapshot({
      useCase: {
        id: "inspect",
        label: "Inspect graph",
        operations: [],
      } as never,
      stores,
      resolvedOperations: [
        {
          operation: {
            kind: "read",
            from: target,
            to: actor,
            label: "reads labels",
            anchor: { id: "readLabels", title: "Read labels" },
          },
          actor,
          target,
        },
      ] as never,
      highlights: selectDatabaseOperationHighlights([], null),
      selectedNodeId: null,
      expandedNodeIds: new Set(["store:graphDb"]),
    });

    const tableNode = snapshot.nodes?.find(
      (node) => node.id === "product.graphDb.tables.nodes",
    );
    expect(tableNode).toMatchObject({
      label: "nodes",
      description: "Table",
    });
    expect(
      tableNode?.dataStoreSchemaSections?.flatMap((section) =>
        section.rows.map((row) => row.label),
      ),
    ).toEqual(["id", "label", "props_json"]);
  });

  it("expands operation data stores by default so table rows are visible", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            graphDb: {
              label: "Graph database",
              kind: "database",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    props_json: { type: "json" },
                  },
                },
                edges: {
                  schema: {
                    from_id: { type: "text", fk: "nodes.id" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const stores = defineSoftwareStores(model, {
      graphDb: { path: "product.graphDb" },
    });
    const actor = {
      __kind: "db-actor-ref",
      id: "writer",
      label: "Writer",
    };
    const operations = [
      {
        operation: {
          kind: "write",
          from: actor,
          to: stores.graphDb.tables?.nodes.id,
          label: "writes node ids",
          anchor: { id: "writeNodes", title: "Write nodes" },
        },
        actor,
        target: stores.graphDb.tables?.nodes.id,
      },
      {
        operation: {
          kind: "write",
          from: actor,
          to: stores.graphDb.tables?.edges.from_id,
          label: "writes edge endpoints",
          anchor: { id: "writeEdges", title: "Write edges" },
        },
        actor,
        target: stores.graphDb.tables?.edges.from_id,
      },
    ] as never;
    const snapshot = databaseC4Snapshot({
      useCase: {
        id: "publish",
        label: "Publish graph",
        operations: [],
      } as never,
      stores,
      resolvedOperations: operations,
      highlights: selectDatabaseOperationHighlights([], null),
      selectedNodeId: null,
      expandedNodeIds: initialDatabaseC4ExpandedNodeIds(operations),
    });

    expect(snapshot.nodes?.map((node) => node.id).sort()).toEqual([
      "actor:writer",
      "product.graphDb.tables.edges",
      "product.graphDb.tables.nodes",
      "store:graphDb",
    ]);
    expect(
      snapshot.nodes
        ?.find((node) => node.id === "product.graphDb.tables.nodes")
        ?.dataStoreSchemaSections?.flatMap((section) =>
          section.rows.map((row) => row.label),
        ),
    ).toEqual(["id", "props_json"]);
    expect(
      snapshot.relationships?.find(
        (relationship) => relationship.id === "writeNodes",
      ),
    ).toMatchObject({
      to: "product.graphDb.tables.nodes",
      toSchemaFieldPath: ["id"],
      toSchemaEndpointKind: "field",
    });
  });

  it("does not re-expand a default data store after the reader collapses it", () => {
    const seededDefaultNodeIds = new Set(["store:graphDb"]);
    const next = seedDatabaseC4DefaultExpandedNodeIds({
      expandedNodeIds: new Set(),
      seededDefaultNodeIds,
      defaultExpandedNodeIds: new Set(["store:graphDb"]),
    });

    expect([...next.expandedNodeIds]).toEqual([]);
    expect([...next.seededDefaultNodeIds]).toEqual(["store:graphDb"]);
  });

  it("still expands newly introduced default data stores", () => {
    const next = seedDatabaseC4DefaultExpandedNodeIds({
      expandedNodeIds: new Set(["store:graphDb"]),
      seededDefaultNodeIds: new Set(["store:graphDb"]),
      defaultExpandedNodeIds: new Set(["store:graphDb", "store:auditDb"]),
    });

    expect([...next.expandedNodeIds].sort()).toEqual([
      "store:auditDb",
      "store:graphDb",
    ]);
    expect([...next.seededDefaultNodeIds].sort()).toEqual([
      "store:auditDb",
      "store:graphDb",
    ]);
  });

  it("keeps DB lens layout stable when guided tour highlights move between operations", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            graphDb: {
              label: "Graph database",
              kind: "database",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    props_json: { type: "json" },
                  },
                },
                edges: {
                  schema: {
                    from_id: { type: "text", fk: "nodes.id" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const stores = defineSoftwareStores(model, {
      graphDb: { path: "product.graphDb" },
    });
    const actor = {
      __kind: "db-actor-ref",
      id: "reader",
      label: "Reader",
    };
    const operations = [
      {
        operation: {
          kind: "read",
          from: stores.graphDb.tables?.nodes.id,
          to: actor,
          label: "reads node ids",
          anchor: { id: "readNodes", title: "Read nodes" },
        },
        actor,
        target: stores.graphDb.tables?.nodes.id,
      },
      {
        operation: {
          kind: "read",
          from: stores.graphDb.tables?.edges.from_id,
          to: actor,
          label: "reads edge endpoints",
          anchor: { id: "readEdges", title: "Read edges" },
        },
        actor,
        target: stores.graphDb.tables?.edges.from_id,
      },
    ] as never;
    const highlightInputs = [
      {
        anchorId: "readNodes",
        targetKey: "graphDb.tables.nodes.id",
      },
      {
        anchorId: "readEdges",
        targetKey: "graphDb.tables.edges.from_id",
      },
    ];
    const nodesSnapshot = databaseC4Snapshot({
      useCase: {
        id: "inspect",
        label: "Inspect graph",
        operations: [],
      } as never,
      stores,
      resolvedOperations: operations,
      highlights: selectDatabaseOperationHighlights(
        highlightInputs,
        "readNodes",
      ),
      selectedNodeId: null,
      expandedNodeIds: new Set(["store:graphDb"]),
    });
    const edgesSnapshot = databaseC4Snapshot({
      useCase: {
        id: "inspect",
        label: "Inspect graph",
        operations: [],
      } as never,
      stores,
      resolvedOperations: operations,
      highlights: selectDatabaseOperationHighlights(
        highlightInputs,
        "readEdges",
      ),
      selectedNodeId: null,
      expandedNodeIds: new Set(["store:graphDb"]),
    });

    expect(
      nodesSnapshot.nodes
        ?.flatMap((node) => node.dataStoreSchemaSections ?? [])
        .flatMap((section) => section.rows)
        .filter((row) => row.state === "active")
        .map((row) => row.id),
    ).not.toEqual(
      edgesSnapshot.nodes
        ?.flatMap((node) => node.dataStoreSchemaSections ?? [])
        .flatMap((section) => section.rows)
        .filter((row) => row.state === "active")
        .map((row) => row.id),
    );
    expect(
      c4LayoutSignature(
        nodesSnapshot.nodes ?? [],
        nodesSnapshot.relationships ?? [],
      ),
    ).toBe(
      c4LayoutSignature(
        edgesSnapshot.nodes ?? [],
        edgesSnapshot.relationships ?? [],
      ),
    );
  });

  it("rejects non-data-store software map elements for DatabaseLens stores", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            web: { label: "Web" },
          },
        },
      },
    });

    let caught: unknown;
    try {
      defineSoftwareStores(model, {
        web: {
          path: "product.web",
          tables: {
            sessions: { schema: { id: { type: "text" } } },
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues[0]).toMatchObject({
      path: ["web", "path"],
      message:
        'Software map element "product.web" must be a dataStore to back a DatabaseLens store',
    });
  });
});

describe("database lens operation highlighting", () => {
  const operations = [
    {
      anchorId: "writeSettings",
      targetKey: "appDb:tables:repository_settings:value",
    },
    {
      anchorId: "writeAudit",
      targetKey: "appDb:tables:audit_log:value",
    },
    {
      anchorId: "refreshCache",
      targetKey: "cache:documents:repository_settings:value",
    },
  ];

  it("marks only the requested operation active", () => {
    const highlights = selectDatabaseOperationHighlights(
      operations,
      "writeAudit",
    );

    expect(highlights.activeAnchor).toBe("writeAudit");
    expect(Object.fromEntries(highlights.operationStates)).toEqual({
      writeSettings: "inactive",
      writeAudit: "active",
      refreshCache: "inactive",
    });
    expect([...highlights.activeTargetKeys]).toEqual([
      "appDb:tables:audit_log:value",
    ]);
  });

  it("falls back to the first operation when the active anchor is outside the lens", () => {
    const highlights = selectDatabaseOperationHighlights(
      operations,
      "unrelatedAnchor",
    );

    expect(highlights.activeAnchor).toBe("writeSettings");
    expect(Object.fromEntries(highlights.operationStates)).toEqual({
      writeSettings: "active",
      writeAudit: "inactive",
      refreshCache: "inactive",
    });
  });
});

describe("database lens guided tour steps", () => {
  it("keeps tour stop detail visible when the operation anchor omits detail", () => {
    expect(
      databaseTourStopDetail({
        useCaseLabel: "Publish review",
        operationLabel: "write submitted status",
      }),
    ).toBe("Publish review: write submitted status");
  });

  it("prefers operation anchor detail when present", () => {
    expect(
      databaseTourStopDetail({
        useCaseLabel: "Publish review",
        operationLabel: "write submitted status",
        anchorDetail: "Persist the submitted review event.",
      }),
    ).toBe("Persist the submitted review event.");
  });
});
