import { describe, expect, it } from "vitest";

import { SoftwareModelValidationError, defineSoftwareModel } from "./model";

describe("defineSoftwareModel", () => {
  it("flattens nested C4 and component code element ids into full paths", () => {
    const model = defineSoftwareModel({
      people: {
        reviewer: { label: "Reviewer" },
      },
      systems: {
        progressiveReview: {
          label: "Progressive Review",
          containers: {
            reviewApp: {
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
      "progressiveReview",
      "progressiveReview.reviewApp",
      "progressiveReview.reviewApp.codePeek",
      "progressiveReview.reviewApp.codePeek.loadSource",
    ]);
    expect(
      model.elementsByPath.get(
        "progressiveReview.reviewApp.codePeek.loadSource",
      ),
    ).toMatchObject({
      type: "codeElement",
      parentPath: "progressiveReview.reviewApp.codePeek",
      sourceRanges: [{ file: "src/example.ts", fromLine: 1, toLine: 1 }],
    });
    expect(
      model.elementsByPath.get("progressiveReview.reviewApp.codePeek")
        ?.children,
    ).toEqual(["progressiveReview.reviewApp.codePeek.loadSource"]);
  });

  it("preserves authored change status but rejects authored diff counts", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          changeStatus: "modified",
          containers: {
            reviewApp: {
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

    expect(model.elementsByPath.get("progressiveReview")?.changeStatus).toBe(
      "modified",
    );
    expect(
      model.elementsByPath.get(
        "progressiveReview.reviewApp.codePeek.loadSource",
      )?.changeStatus,
    ).toBe("added");

    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveReview: {
              additions: 3,
            } as never,
          },
        }),
      ),
    ).toEqual([
      'Element "progressiveReview" must not author additions or deletions; diff counts are computed automatically.',
    ]);
  });

  it("normalizes data store kinds and defaults data stores to databases", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
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
      model.elementsByPath.get("progressiveReview.primaryDb")?.dataStoreKind,
    ).toBe("database");
    expect(
      model.elementsByPath.get("progressiveReview.softwareMapStore")
        ?.dataStoreKind,
    ).toBe("artifactStore");

    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveReview: {
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
      'Data store "progressiveReview.weirdStore" kind must be one of "database", "objectStore", "bucket", "artifactStore", or "fileStore".',
    );
  });

  it("normalizes data store tables and documents as map ontology", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
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
      model.elementsByPath.get("progressiveReview.graphDb")?.dataStoreSchema,
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
        progressiveReview: {
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
          from: "progressiveReview.graphEmitter",
          to: "progressiveReview.graphDb.tables.nodes.id",
          label: "writes node rows",
        },
      ],
    });

    expect(model.relationships[0]).toMatchObject({
      from: "progressiveReview.graphEmitter",
      to: "progressiveReview.graphDb.tables.nodes.id",
      semanticKind: "writes",
    });
  });

  it("rejects relationships to missing data store tables and fields", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveReview: {
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
              from: "progressiveReview.graphEmitter",
              to: "progressiveReview.graphDb.tables.edges.id",
            },
            {
              kind: "semantic",
              from: "progressiveReview.graphEmitter",
              to: "progressiveReview.graphDb.tables.nodes.missing",
            },
          ],
        }),
      ),
    ).toEqual([
      'Invalid top-level relationship: endpoint "progressiveReview.graphDb.tables.edges.id" does not match an element path or data store schema path.',
      'Invalid top-level relationship: endpoint "progressiveReview.graphDb.tables.nodes.missing" does not match an element path or data store schema path.',
    ]);
  });

  it("normalizes C4 coverage claims for residual diff accounting", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          coverage: {
            files: [
              "packages/progressive-review/skills/dev-review/SKILL.md",
              {
                path: "packages/progressive-review/app/src/software-map/styles.css",
                ranges: [{ fromLine: 10, toLine: 20 }],
              },
            ],
            globs: [
              "packages/progressive-review/app/src/software-map/*.test.ts",
            ],
          },
          containers: {
            reviewApp: {
              coverage: {
                files: [
                  "packages/progressive-review/app/src/software-map/SoftwareMap.tsx",
                ],
              },
            },
          },
        },
      },
    });

    expect(model.elementsByPath.get("progressiveReview")?.coverage).toEqual({
      files: [
        {
          path: "packages/progressive-review/skills/dev-review/SKILL.md",
          ranges: [],
        },
        {
          path: "packages/progressive-review/app/src/software-map/styles.css",
          ranges: [{ fromLine: 10, toLine: 20 }],
        },
      ],
      globs: ["packages/progressive-review/app/src/software-map/*.test.ts"],
    });
    expect(
      model.elementsByPath.get("progressiveReview.reviewApp")?.coverage,
    ).toEqual({
      files: [
        {
          path: "packages/progressive-review/app/src/software-map/SoftwareMap.tsx",
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
            progressiveReview: {
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
      'Element "progressiveReview" coverage.files[0].ranges[0] must use positive inclusive line numbers with fromLine <= toLine.',
    ]);
  });

  it("normalizes scoped and top-level relationships into global endpoint paths", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
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
          from: "progressiveReview.reviewApp.codePeek.loadSource",
          to: "progressiveReview.reviewApp.codePeek.renderSource",
          semanticKind: "renders",
          sourceRanges: [{ fromLine: 3, toLine: 6 }],
        },
      ],
    });

    expect(model.relationships).toEqual([
      {
        id: "progressiveReview.reviewApp.codePeek.relationship.0",
        kind: "call",
        from: "progressiveReview.reviewApp.codePeek.renderSource",
        to: "progressiveReview.reviewApp.codePeek.highlightRange",
        scopePath: "progressiveReview.reviewApp.codePeek",
        label: undefined,
        description: undefined,
        nthCallSite: 0,
      },
      {
        id: "model.relationship.0",
        kind: "semantic",
        from: "progressiveReview.reviewApp.codePeek.loadSource",
        to: "progressiveReview.reviewApp.codePeek.renderSource",
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
          systems: [{ id: "progressiveReview" }, { id: "progressiveReview" }],
        }),
      ),
    ).toEqual(['Duplicate softwareSystem id "progressiveReview" under model.']);
  });

  it("rejects invalid relationship endpoints", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveReview: {
              containers: {
                reviewApp: {
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
    ).toEqual([
      'Invalid relationship scoped to "progressiveReview.reviewApp.codePeek": endpoint "missingTarget" does not match an element path or data store schema path.',
    ]);
  });

  it("rejects authored views", () => {
    expect(
      expectValidationErrors(() =>
        defineSoftwareModel({
          systems: {
            progressiveReview: {
              containers: {
                reviewApp: {
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
              scope: "progressiveReview.reviewApp.codePeek",
            },
          },
        } as never),
      ),
    ).toEqual([
      "Software model must not author views; SoftwareMap derives inline C4 projection from elements, relationships, and expansion state.",
    ]);
  });
});

function expectValidationErrors(action: () => unknown) {
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
