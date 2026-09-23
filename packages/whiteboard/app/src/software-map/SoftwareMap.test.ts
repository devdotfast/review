import { describe, expect, it } from "vitest";

import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";

describe("SoftwareMap inline C4 helpers", () => {
  it("can hide removed topology while preserving live changed nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          containers: {
            whiteboardApp: {
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
          from: "progressiveWhiteboard.whiteboardApp.liveComponent.liveSymbol",
          to: "progressiveWhiteboard.whiteboardApp.removedComponent.removedSymbol",
          label: "called old code",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "progressiveWhiteboard",
        "progressiveWhiteboard.whiteboardApp",
        "progressiveWhiteboard.whiteboardApp.liveComponent",
        "progressiveWhiteboard.whiteboardApp.removedComponent",
      ]),
      showRemovedNodes: false,
    });

    expect(projection.nodes.map((node) => node.id)).toContain(
      "progressiveWhiteboard.whiteboardApp.liveComponent.liveSymbol",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveWhiteboard.whiteboardApp.removedComponent",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveWhiteboard.whiteboardApp.removedComponent.removedSymbol",
    );
    expect(projection.relationships).toHaveLength(0);
  });
});
