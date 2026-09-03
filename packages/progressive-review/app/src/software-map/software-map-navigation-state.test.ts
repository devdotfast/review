import { describe, expect, it } from "vitest";

import { testReviewSession } from "../review-session-test-utils";
import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  clearSoftwareMapNavigationStateForTests,
  initialSoftwareMapExpandedNodeIds,
  rememberSoftwareMapNavigationState,
  restoreSoftwareMapNavigationState,
  seedSoftwareMapDefaultExpandedNodeIds,
  softwareMapAncestorPaths,
  softwareMapNavigationKey,
} from "./software-map-navigation-state";

describe("SoftwareMap navigation state", () => {
  it("derives ancestors for map-backed side peek focus requests", () => {
    expect(
      softwareMapAncestorPaths(
        "progressiveReview.reviewApp.databaseLens.persistOperation",
      ),
    ).toEqual([
      "progressiveReview",
      "progressiveReview.reviewApp",
      "progressiveReview.reviewApp.databaseLens",
    ]);
  });

  it("persists selected node and expanded node ids by model identity", () => {
    const session = testReviewSession();
    clearSoftwareMapNavigationStateForTests(session);
    const key = softwareMapNavigationKey({
      title: "CI SoftwareMap",
      view: "inline",
    });

    rememberSoftwareMapNavigationState(session, key, {
      modelKey: "model:a",
      expandedNodeIds: ["devFastCi", "devFastCi.ciWorker"],
      selectedNodeId: "devFastCi.ciWorker",
      expanded: true,
    });

    expect(restoreSoftwareMapNavigationState(session, key, "model:a")).toEqual({
      modelKey: "model:a",
      expandedNodeIds: ["devFastCi", "devFastCi.ciWorker"],
      selectedNodeId: "devFastCi.ciWorker",
      expanded: true,
    });
    expect(restoreSoftwareMapNavigationState(session, key, "model:b")).toEqual({
      modelKey: "model:b",
      expandedNodeIds: [],
      selectedNodeId: null,
      expanded: false,
    });
  });

  it("defaults every non-component expandable node to expanded", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
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
            graph: {
              tables: {
                nodes: { schema: { id: { type: "string", pk: true } } },
              },
            },
          },
        },
      },
    });

    expect([...initialSoftwareMapExpandedNodeIds(model)].sort()).toEqual([
      "app",
      "app.graph",
      "app.web",
    ]);
  });

  it("seeds nested default expansion once the complete model is available", () => {
    const initialModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {},
          },
        },
      },
    });
    const completeModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
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

    const initialExpandedNodeIds =
      initialSoftwareMapExpandedNodeIds(initialModel);
    expect([...initialExpandedNodeIds]).toEqual(["app"]);

    const expandedNodeIds = seedSoftwareMapDefaultExpandedNodeIds({
      expandedNodeIds: initialExpandedNodeIds,
      model: completeModel,
      defaultExpansionActive: true,
    });
    expect([...expandedNodeIds].sort()).toEqual(["app", "app.web"]);

    const projection = projectInlineC4({
      model: completeModel,
      expandedNodeIds,
    });
    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app", isExpanded: true }),
        expect.objectContaining({ id: "app.web", isExpanded: true }),
        expect.objectContaining({
          id: "app.web.ui",
          isExpanded: false,
        }),
      ]),
    );
    expect(projection.visibleNodeIds.has("app.web.ui.render")).toBe(false);
  });

  it("does not re-expand a default node after the user collapses it", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
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

    expect(
      [
        ...seedSoftwareMapDefaultExpandedNodeIds({
          expandedNodeIds: new Set(["app"]),
          model,
          defaultExpansionActive: false,
        }),
      ].sort(),
    ).toEqual(["app"]);
  });
});
