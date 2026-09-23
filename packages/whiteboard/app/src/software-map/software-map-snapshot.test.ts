import { describe, expect, it } from "vitest";

import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  type SoftwareMapResolvedSnapshot,
  buildSoftwareMapChangeSummaries,
  c4DisplayedSnapshotForCurrentState,
  softwareMapNodeDiffPeeks,
  softwareMapSnapshotFromInlineC4Projection,
  visibleSoftwareMapChangeCount,
} from "./software-map-snapshot";

describe("SoftwareMap snapshot helpers", () => {
  it("opens unchanged code at the map's explicit pinned side", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            ui: {
              components: {
                view: {
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "view.ts", fromLine: 2, toLine: 8 },
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

    const changeSummaries = buildSoftwareMapChangeSummaries(
      model,
      new Map(),
      new Map(),
    );

    expect(
      softwareMapNodeDiffPeeks({
        model,
        elementPath: "app",
        changeSummaries,
        sourceSide: "base",
      }),
    ).toEqual([{ file: "view.ts", fromLine: 2, toLine: 8, graph: "base" }]);
  });
  it("derives coverage and source-range diffs for an aggregate map node", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            runtime: {
              components: {
                api: {
                  coverage: {
                    files: [
                      {
                        path: "src/api.ts",
                        ranges: [{ fromLine: 8, toLine: 14 }],
                      },
                    ],
                  },
                },
                worker: {
                  codeElements: {
                    run: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
                removedJob: {
                  coverage: { files: ["src/removed-job.ts"] },
                },
              },
            },
          },
        },
      },
    });

    const summaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([["product.runtime.worker.run", { additions: 2, deletions: 1 }]]),
      new Map([
        [
          "product.runtime.api",
          {
            additions: 1,
            deletions: 1,
            files: [
              {
                file: "src/api.ts",
                additions: 1,
                deletions: 1,
                hunks: [
                  {
                    startLine: 10,
                    lines: [
                      {
                        kind: "remove" as const,
                        oldLine: 10,
                        newLine: null,
                        text: "oldApi();",
                      },
                      {
                        kind: "add" as const,
                        oldLine: null,
                        newLine: 10,
                        text: "newApi();",
                      },
                    ],
                  },
                  {
                    startLine: 510,
                    lines: [
                      {
                        kind: "add" as const,
                        oldLine: null,
                        newLine: 510,
                        text: "newFarAwayApi();",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        [
          "product.runtime.removedJob",
          {
            additions: 0,
            deletions: 2,
            files: [
              {
                file: "src/removed-job.ts",
                additions: 0,
                deletions: 2,
                hunks: [
                  {
                    startLine: 20,
                    lines: [
                      {
                        kind: "remove" as const,
                        oldLine: 20,
                        newLine: null,
                        text: "runOldJob();",
                      },
                      {
                        kind: "remove" as const,
                        oldLine: 21,
                        newLine: null,
                        text: "finishOldJob();",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      ]),
    );

    const peeks = softwareMapNodeDiffPeeks({
      model,
      elementPath: "product.runtime",
      changeSummaries: summaries,
    });

    expect(peeks).toEqual([
      {
        file: "src/api.ts",
        fromLine: 10,
        toLine: 10,
        graph: "head",
      },
      {
        file: "src/api.ts",
        fromLine: 510,
        toLine: 510,
        graph: "head",
      },
      {
        file: "src/example.ts",
        fromLine: 1,
        toLine: 1,
        graph: "head",
      },
      {
        file: "src/removed-job.ts",
        fromLine: 20,
        toLine: 21,
        graph: "base",
      },
    ]);
  });

  it("hides zero-value map diff counts", () => {
    expect(visibleSoftwareMapChangeCount(0)).toBe(0);
    expect(visibleSoftwareMapChangeCount(-1)).toBe(0);
    expect(visibleSoftwareMapChangeCount(Number.NaN)).toBe(0);
    expect(visibleSoftwareMapChangeCount(3)).toBe(3);
  });

  it("keeps rendered C4 selection current while reusing an existing layout", () => {
    const layoutSnapshot: SoftwareMapResolvedSnapshot = {
      viewType: "inlineC4",
      selectedNodeId: "root",
      nodes: [
        { id: "root", label: "Root", type: "softwareSystem" },
        {
          id: "root.child",
          label: "Child",
          type: "container",
          parentId: "root",
        },
      ],
      relationships: [],
    };

    const currentSnapshot: SoftwareMapResolvedSnapshot = {
      ...layoutSnapshot,
      selectedNodeId: "root.child",
    };

    const displayed = c4DisplayedSnapshotForCurrentState(
      layoutSnapshot,
      currentSnapshot,
    );

    expect(displayed.selectedNodeId).toBe("root.child");
    expect(layoutSnapshot.selectedNodeId).toBe("root");
  });

  it("turns objective inline projection into render snapshots", () => {
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
                softwareMap: {
                  label: "SoftwareMap",
                  codeElements: {
                    renderer: {
                      sourceRanges: [
                        {
                          file: "packages/whiteboard/app/src/software-map/SoftwareMap.tsx",
                          fromLine: 1,
                          toLine: 1,
                        },
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
          from: "reviewer",
          to: "progressiveWhiteboard.whiteboardApp.softwareMap.renderer",
          label: "reviews",
        },
      ],
    });

    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["progressiveWhiteboard"]),
        selectedNodeId: "progressiveWhiteboard",
      }),
    });

    expect(snapshot.viewType).toBe("inlineC4");
    expect(snapshot.selectedNodeId).toBe("progressiveWhiteboard");
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "progressiveWhiteboard",
          label: "Progressive Review",
          expanded: true,
          expandable: true,
          childCount: 1,
        }),
        expect.objectContaining({
          id: "progressiveWhiteboard.whiteboardApp",
          label: "Review App",
          type: "container",
        }),
      ]),
    );
    expect(snapshot.relationships).toEqual([
      expect.objectContaining({
        from: "reviewer",
        to: "progressiveWhiteboard.whiteboardApp",
        kind: "semantic",
      }),
    ]);
  });

  it("uses coverage counts for C4 node badges instead of child code counts", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          containers: {
            whiteboardApp: {
              components: {
                softwareMap: {
                  coverage: {
                    files: ["src/software-map.tsx"],
                  },
                  changeStatus: "removed",
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                    layout: {
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

    const changeSummaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([
        [
          "progressiveWhiteboard.whiteboardApp.softwareMap.render",
          { additions: 4, deletions: 2 },
        ],
      ]),
      new Map([
        [
          "progressiveWhiteboard.whiteboardApp.softwareMap",
          { additions: 7, deletions: 1, files: [] },
        ],
      ]),
    );

    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set([
          "progressiveWhiteboard",
          "progressiveWhiteboard.whiteboardApp",
        ]),
        selectedNodeId: "progressiveWhiteboard.whiteboardApp.softwareMap",
      }),
      changeSummaries,
    });

    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "progressiveWhiteboard.whiteboardApp.softwareMap",
          changeStatus: "removed",
          authoredChangeStatus: "removed",
          additions: 7,
          deletions: 1,
        }),
      ]),
    );
    expect(snapshot.unmappedDiff).toMatchObject({
      additions: 7,
      deletions: 1,
    });
  });

  it("keeps code counts on code nodes while C4 counts come from coverage", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          containers: {
            whiteboardApp: {
              components: {
                coveredComponent: {
                  coverage: {
                    files: ["src/covered.ts"],
                  },
                  changeStatus: "unchanged",
                  codeElements: {
                    createdSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
                uncoveredComponent: {
                  codeElements: {
                    changedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
                topologicallyAdded: {
                  codeElements: {
                    addedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "added",
                    },
                  },
                },
                topologicallyRemoved: {
                  codeElements: {
                    removedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "removed",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const changeSummaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([
        [
          "progressiveWhiteboard.whiteboardApp.coveredComponent.createdSymbol",
          { additions: 21, deletions: 0 },
        ],
        [
          "progressiveWhiteboard.whiteboardApp.uncoveredComponent.changedSymbol",
          { additions: 4, deletions: 2 },
        ],
      ]),
      new Map([
        [
          "progressiveWhiteboard.whiteboardApp.coveredComponent",
          { additions: 8, deletions: 1, files: [] },
        ],
      ]),
    );

    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.coveredComponent.createdSymbol",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 21, deletions: 0 });
    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.coveredComponent",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 8, deletions: 1 });
    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.uncoveredComponent.changedSymbol",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 4, deletions: 2 });
    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.uncoveredComponent",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 0, deletions: 0 });
    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.topologicallyAdded.addedSymbol",
      ),
    ).toMatchObject({ changeStatus: "added", additions: 0, deletions: 0 });
    expect(
      changeSummaries.get(
        "progressiveWhiteboard.whiteboardApp.topologicallyRemoved.removedSymbol",
      ),
    ).toMatchObject({ changeStatus: "removed", additions: 0, deletions: 0 });
    expect(
      changeSummaries.get("progressiveWhiteboard.whiteboardApp"),
    ).toMatchObject({
      changeStatus: "modified",
      additions: 8,
      deletions: 1,
    });
  });

  it("rolls topology-only child modifications up to C4 parents", () => {
    const model = defineSoftwareModel({
      systems: {
        devFast: {
          containers: {
            cli: {
              label: "dev CLI",
              components: {
                commandRouter: {
                  label: "Command router",
                  changeStatus: "modified",
                },
              },
            },
          },
        },
      },
    });

    const changeSummaries = buildSoftwareMapChangeSummaries(model);

    expect(changeSummaries.get("devFast.cli.commandRouter")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(changeSummaries.get("devFast.cli")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(changeSummaries.get("devFast")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
  });
});
