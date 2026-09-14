import { describe, expect, it } from "vitest";

import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";

describe("SoftwareMap inline C4 helpers", () => {
  it("can hide removed topology while preserving live changed nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
              components: {
                liveComponent: {
                  codeElements: {
                    liveSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
                removedComponent: {
                  changeStatus: "removed",
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
      relationships: [
        {
          kind: "semantic",
          from: "progressiveReview.reviewApp.liveComponent.liveSymbol",
          to: "progressiveReview.reviewApp.removedComponent.removedSymbol",
          label: "called old code",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "progressiveReview",
        "progressiveReview.reviewApp",
        "progressiveReview.reviewApp.liveComponent",
        "progressiveReview.reviewApp.removedComponent",
      ]),
      showRemovedNodes: false,
    });

    expect(projection.nodes.map((node) => node.id)).toContain(
      "progressiveReview.reviewApp.liveComponent.liveSymbol",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent.removedSymbol",
    );
    expect(projection.relationships).toHaveLength(0);
  });
});
