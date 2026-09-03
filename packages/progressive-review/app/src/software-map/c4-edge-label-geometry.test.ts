import { describe, expect, it } from "vitest";

import {
  c4EdgePointsFromSections,
  positionC4EdgeLabels,
} from "./c4-edge-label-geometry";

describe("SoftwareMap edge label geometry", () => {
  it("uses routed C4 edge sections without schema endpoint rewrites", () => {
    const points = c4EdgePointsFromSections([
      {
        startPoint: { x: 100, y: 100 },
        bendPoints: [
          { x: 160, y: 100 },
          { x: 160, y: 220 },
        ],
        endPoint: { x: 260, y: 220 },
      },
    ]);

    expect(points).toEqual([
      { x: 100, y: 100 },
      { x: 160, y: 100 },
      { x: 160, y: 220 },
      { x: 260, y: 220 },
    ]);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const next = points[index]!;
      expect(previous.x === next.x || previous.y === next.y).toBe(true);
    }
  });

  it("keeps positioned C4 edge labels on their edges while avoiding overlaps", () => {
    const edgeSections = new Map([
      [
        "edge-a",
        [
          {
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 420, y: 0 },
          },
        ],
      ],
      [
        "edge-b",
        [
          {
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 420, y: 0 },
          },
        ],
      ],
    ]);
    const edgeLabels = new Map([
      ["edge-a", { x: 180, y: -12, width: 96, height: 24 }],
      ["edge-b", { x: 180, y: -12, width: 96, height: 24 }],
    ]);
    const nodeObstacles = [{ x: 150, y: -44, width: 120, height: 88 }];

    const positioned = positionC4EdgeLabels(
      edgeSections,
      edgeLabels,
      nodeObstacles,
    );
    const first = positioned.get("edge-a");
    const second = positioned.get("edge-b");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.y + first!.height / 2).toBe(0);
    expect(second!.y + second!.height / 2).toBe(0);
    expect(labelBoxesOverlapForTest(first!, nodeObstacles[0]!)).toBe(false);
    expect(labelBoxesOverlapForTest(second!, nodeObstacles[0]!)).toBe(false);
    expect(labelBoxesOverlapForTest(first!, second!)).toBe(false);
  });
});

function labelBoxesOverlapForTest(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}
