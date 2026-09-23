import { describe, expect, it } from "vitest";

import { SoftwareModelValidationError, defineSoftwareModel } from "./model";

describe("defineSoftwareModel", () => {
  it("flattens nested C4 and component code element ids into full paths", () => {
    const model = defineSoftwareModel({
      people: {
        reviewer: { label: "Whiteboarder" },
      },
      systems: {
        progressiveWhiteboard: {
          label: "Progressive Review",
          containers: {
            whiteboardApp: {
              label: "Review App",
              components: {
                codePeek: {
                  label: "CodePeek",
                  codeElements: {
                    loadSource: {
                      label: "loadSource",
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
    });

    expect(model.elements.map((element) => element.path)).toEqual([
      "reviewer",
      "progressiveWhiteboard",
      "progressiveWhiteboard.whiteboardApp",
      "progressiveWhiteboard.whiteboardApp.codePeek",
      "progressiveWhiteboard.whiteboardApp.codePeek.loadSource",
    ]);
    expect(
      model.elementsByPath.get(
        "progressiveWhiteboard.whiteboardApp.codePeek.loadSource",
      ),
    ).toMatchObject({
      type: "codeElement",
      parentPath: "progressiveWhiteboard.whiteboardApp.codePeek",
      sourceRanges: [{ file: "src/example.ts", fromLine: 1, toLine: 1 }],
    });
    expect(
      model.elementsByPath.get("progressiveWhiteboard.whiteboardApp.codePeek")
        ?.children,
    ).toEqual(["progressiveWhiteboard.whiteboardApp.codePeek.loadSource"]);
  });

  it("preserves authored change status but rejects authored diff counts", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          changeStatus: "modified",
          containers: {
            whiteboardApp: {
              components: {
                codePeek: {
                  codeElements: {
                    loadSource: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "added",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      model.elementsByPath.get("progressiveWhiteboard")?.changeStatus,
    ).toBe("modified");
    expect(
      model.elementsByPath.get(
        "progressiveWhiteboard.whiteboardApp.codePeek.loadSource",
      )?.changeStatus,
    ).toBe("added");

    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveWhiteboard: {
              additions: 3,
            } as never,
          },
        }),
      ),
    ).toEqual([
      'Element "progressiveWhiteboard" must not author additions or deletions; diff counts are computed automatically.',
    ]);
  });

  it("normalizes data store kinds and defaults data stores to databases", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          dataStores: {
            primaryDb: {},
            softwareMapStore: {
              kind: "artifactStore",
            },
          },
        },
      },
    });

    expect(
      model.elementsByPath.get("progressiveWhiteboard.primaryDb")
        ?.dataStoreKind,
    ).toBe("database");
    expect(
      model.elementsByPath.get("progressiveWhiteboard.softwareMapStore")
        ?.dataStoreKind,
    ).toBe("artifactStore");

    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveWhiteboard: {
              dataStores: {
                weirdStore: {
                  kind: "queue",
                } as never,
              },
            },
          },
        }),
      ),
    ).toContain(
      'Data store "progressiveWhiteboard.weirdStore" kind must be one of "database", "objectStore", "bucket", "artifactStore", or "fileStore".',
    );
  });

  it("normalizes data store tables and documents as map ontology", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          dataStores: {
            graphDb: {
              kind: "database",
              tables: {
                nodes: {
                  schema: {
                    id: { type: "text", pk: true },
                    source_file: { type: "text", fk: "source_files.path" },
                  },
                },
              },
              documents: {
                metadata: {
                  key: "path",
                  schema: {
                    graphDbPath: { type: "text" },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      model.elementsByPath.get("progressiveWhiteboard.graphDb")
        ?.dataStoreSchema,
    ).toMatchObject({
      tables: {
        nodes: {
          id: "nodes",
          label: "nodes",
          schema: {
            id: { type: "text", pk: true },
            source_file: { type: "text", fk: "source_files.path" },
          },
        },
      },
      documents: {
        metadata: {
          id: "metadata",
          label: "metadata",
          key: "path",
          schema: {
            graphDbPath: { type: "text" },
          },
        },
      },
    });
  });

  it("allows relationships to target data store tables and fields", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          containers: {
            graphEmitter: {},
          },
          dataStores: {
            graphDb: {
              kind: "database",
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
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          semanticKind: "writes",
          from: "progressiveWhiteboard.graphEmitter",
          to: "progressiveWhiteboard.graphDb.tables.nodes.id",
          label: "writes node rows",
        },
      ],
    });

    expect(model.relationships[0]).toMatchObject({
      from: "progressiveWhiteboard.graphEmitter",
      to: "progressiveWhiteboard.graphDb.tables.nodes.id",
      semanticKind: "writes",
    });
  });

  it("rejects relationships to missing data store tables and fields", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveWhiteboard: {
              containers: {
                graphEmitter: {},
              },
              dataStores: {
                graphDb: {
                  kind: "database",
                  tables: {
                    nodes: {
                      schema: {
                        id: { type: "text", pk: true },
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
              from: "progressiveWhiteboard.graphEmitter",
              to: "progressiveWhiteboard.graphDb.tables.edges.id",
            },
            {
              kind: "semantic",
              from: "progressiveWhiteboard.graphEmitter",
              to: "progressiveWhiteboard.graphDb.tables.nodes.missing",
            },
          ],
        }),
      ),
    ).toEqual([
      expect.stringContaining("progressiveWhiteboard.graphDb.tables.edges.id"),
      expect.stringContaining(
        "progressiveWhiteboard.graphDb.tables.nodes.missing",
      ),
    ]);
  });

  it("normalizes C4 coverage claims for residual diff accounting", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          coverage: {
            files: [
              "packages/whiteboard/skills/dev-review/SKILL.md",
              {
                path: "packages/whiteboard/app/src/software-map/styles.css",
                ranges: [{ fromLine: 10, toLine: 20 }],
              },
            ],
            globs: ["packages/whiteboard/app/src/software-map/*.test.ts"],
          },
          containers: {
            whiteboardApp: {
              coverage: {
                files: [
                  "packages/whiteboard/app/src/software-map/SoftwareMap.tsx",
                ],
              },
            },
          },
        },
      },
    });

    expect(model.elementsByPath.get("progressiveWhiteboard")?.coverage).toEqual(
      {
        files: [
          {
            path: "packages/whiteboard/skills/dev-review/SKILL.md",
            ranges: [],
          },
          {
            path: "packages/whiteboard/app/src/software-map/styles.css",
            ranges: [{ fromLine: 10, toLine: 20 }],
          },
        ],
        globs: ["packages/whiteboard/app/src/software-map/*.test.ts"],
      },
    );
    expect(
      model.elementsByPath.get("progressiveWhiteboard.whiteboardApp")?.coverage,
    ).toEqual({
      files: [
        {
          path: "packages/whiteboard/app/src/software-map/SoftwareMap.tsx",
          ranges: [],
        },
      ],
      globs: [],
    });

    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          people: {
            reviewer: {
              coverage: { files: ["README.md"] },
            } as never,
          },
          systems: {
            progressiveWhiteboard: {
              coverage: {
                files: [
                  {
                    path: "README.md",
                    ranges: [{ fromLine: 5, toLine: 4 }],
                  },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual([
      'Element "reviewer" coverage may only be authored on systems, containers, data stores, or components.',
      'Element "progressiveWhiteboard" coverage.files[0].ranges[0] must use positive inclusive line numbers with fromLine <= toLine.',
    ]);
  });

  it("normalizes scoped and top-level relationships into global endpoint paths", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          containers: {
            whiteboardApp: {
              components: {
                codePeek: {
                  codeElements: {
                    loadSource: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                    renderSource: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                    highlightRange: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                  relationships: [
                    {
                      kind: "call",
                      from: "renderSource",
                      to: "highlightRange",
                    },
                  ],
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "progressiveWhiteboard.whiteboardApp.codePeek.loadSource",
          to: "progressiveWhiteboard.whiteboardApp.codePeek.renderSource",
          semanticKind: "renders",
          sourceRanges: [{ fromLine: 3, toLine: 6 }],
        },
      ],
    });

    expect(model.relationships).toEqual([
      {
        id: "progressiveWhiteboard.whiteboardApp.codePeek.relationship.0",
        kind: "call",
        from: "progressiveWhiteboard.whiteboardApp.codePeek.renderSource",
        to: "progressiveWhiteboard.whiteboardApp.codePeek.highlightRange",
        scopePath: "progressiveWhiteboard.whiteboardApp.codePeek",
        label: undefined,
        description: undefined,
        nthCallSite: 0,
      },
      {
        id: "model.relationship.0",
        kind: "semantic",
        from: "progressiveWhiteboard.whiteboardApp.codePeek.loadSource",
        to: "progressiveWhiteboard.whiteboardApp.codePeek.renderSource",
        scopePath: undefined,
        label: undefined,
        description: undefined,
        semanticKind: "renders",
        sourceRanges: [{ fromLine: 3, toLine: 6 }],
      },
    ]);
  });

  it("detects duplicate sibling ids", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: [
            { id: "progressiveWhiteboard" },
            { id: "progressiveWhiteboard" },
          ],
        }),
      ),
    ).toEqual([
      'Duplicate softwareSystem id "progressiveWhiteboard" under model.',
    ]);
  });

  it("rejects invalid relationship endpoints", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveWhiteboard: {
              containers: {
                whiteboardApp: {
                  components: {
                    codePeek: {
                      codeElements: {
                        renderSource: {
                          sourceRanges: [
                            { file: "src/example.ts", fromLine: 1, toLine: 1 },
                          ],
                        },
                      },
                      relationships: [
                        {
                          kind: "semantic",
                          from: "renderSource",
                          to: "missingTarget",
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toEqual([expect.stringContaining("missingTarget")]);
  });

  it("rejects authored views", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveWhiteboard: {
              containers: {
                whiteboardApp: {
                  components: {
                    codePeek: {
                      codeElements: {
                        loadSource: {
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
          views: {
            codePeekCode: {
              type: "code",
              scope: "progressiveWhiteboard.whiteboardApp.codePeek",
            },
          },
        } as never),
      ),
    ).toEqual([
      "Software model must not author views; SoftwareMap derives inline C4 projection from elements, relationships, and expansion state.",
    ]);
  });
});

function expectValidationErrors(action: () => void) {
  try {
    action();
  } catch (error) {
    if (error instanceof SoftwareModelValidationError) {
      return error.errors;
    }

    throw error;
  }

  throw new Error("Expected SoftwareModelValidationError");
}
