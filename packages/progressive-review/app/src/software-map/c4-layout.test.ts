import { describe, expect, it } from "vitest";

import {
  type C4LayoutResult,
  C4_LAYOUT_CARD_HEIGHT,
  C4_LAYOUT_CARD_WIDTH,
  C4_LAYOUT_CHILD_COLUMN_GAP,
  C4_LAYOUT_GROUP_PADDING,
  createC4ChildLayoutKey,
  layoutInlineC4,
} from "./c4-layout";

describe("layoutInlineC4", () => {
  it("places child cards inside an expanded group bbox", () => {
    const layout = layoutInlineC4({
      nodes: [
        { id: "system", children: ["containerA", "containerB"] },
        { id: "containerA", parentPath: "system" },
        { id: "containerB", parentPath: "system" },
      ],
      relationships: [],
      expandedIds: ["system"],
    });

    const group = layout.groupBboxes.get("system")!;
    const containerA = layout.nodeBboxes.get("containerA")!;
    const containerB = layout.nodeBboxes.get("containerB")!;

    expect(containerA.x).toBe(group.x + C4_LAYOUT_GROUP_PADDING.left);
    expect(containerA.y).toBe(group.y + C4_LAYOUT_GROUP_PADDING.top);
    expect(containerB.x).toBe(
      containerA.x + C4_LAYOUT_CARD_WIDTH + C4_LAYOUT_CHILD_COLUMN_GAP,
    );
    expect(containerB.y).toBe(containerA.y);
  });

  it("sizes an expanded group to include children plus label and control padding", () => {
    const layout = layoutInlineC4({
      nodes: [
        { id: "system", children: ["containerA", "containerB"] },
        { id: "containerA", parentPath: "system" },
        { id: "containerB", parentPath: "system" },
      ],
      relationships: [],
      expandedIds: ["system"],
    });

    const group = layout.groupBboxes.get("system")!;
    const containerB = layout.nodeBboxes.get("containerB")!;
    const expectedRight =
      containerB.x + C4_LAYOUT_CARD_WIDTH + C4_LAYOUT_GROUP_PADDING.right;
    const expectedBottom =
      containerB.y + C4_LAYOUT_CARD_HEIGHT + C4_LAYOUT_GROUP_PADDING.bottom;

    expect(group.x + group.width).toBe(expectedRight);
    expect(group.y + group.height).toBe(expectedBottom);
  });

  it("pushes a local neighbor without reshuffling unrelated roots", () => {
    const previousLayout = previousBoxes({
      nodeBboxes: {
        system: {
          x: 0,
          y: 0,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
        neighbor: {
          x: 240,
          y: 0,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
        distant: {
          x: 900,
          y: 0,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
      },
    });

    const layout = layoutInlineC4({
      nodes: [
        { id: "system", children: ["containerA", "containerB"] },
        { id: "containerA", parentPath: "system" },
        { id: "containerB", parentPath: "system" },
        { id: "neighbor" },
        { id: "distant" },
      ],
      relationships: [],
      expandedIds: ["system"],
      previousLayout,
    });

    expect(layout.nodeBboxes.get("neighbor")!.x).toBeGreaterThan(240);
    expect(layout.nodeBboxes.get("distant")!.x).toBe(900);
  });

  it("uses measured card dimensions when spacing expanded children", () => {
    const layout = layoutInlineC4({
      nodes: [
        { id: "system", children: ["containerA", "containerB"] },
        { id: "containerA", parentPath: "system", width: 340, height: 140 },
        { id: "containerB", parentPath: "system", width: 320, height: 130 },
      ],
      relationships: [],
      expandedIds: ["system"],
    });

    const containerA = layout.nodeBboxes.get("containerA")!;
    const containerB = layout.nodeBboxes.get("containerB")!;

    expect(containerA.width).toBe(340);
    expect(containerA.height).toBe(140);
    expect(containerB.x).toBe(
      containerA.x + containerA.width + C4_LAYOUT_CHILD_COLUMN_GAP,
    );
    expect(containerA.x + containerA.width).toBeLessThanOrEqual(containerB.x);
  });

  it("moves a colliding expanded subtree as one atomic unit", () => {
    const previousLayout = previousBoxes({
      nodeBboxes: {
        systemA: {
          x: 276,
          y: 16,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
        a1: {
          x: 276,
          y: 84,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
        a2: {
          x: 276 + C4_LAYOUT_CARD_WIDTH + C4_LAYOUT_CHILD_COLUMN_GAP,
          y: 84,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
        systemB: {
          x: 0,
          y: 0,
          width: C4_LAYOUT_CARD_WIDTH,
          height: C4_LAYOUT_CARD_HEIGHT,
        },
      },
      groupBboxes: {
        systemA: { x: 240, y: 0, width: 608, height: 216 },
      },
    });

    const layout = layoutInlineC4({
      nodes: [
        { id: "systemB", children: ["b1", "b2"] },
        { id: "b1", parentPath: "systemB" },
        { id: "b2", parentPath: "systemB" },
        { id: "systemA", children: ["a1", "a2"] },
        { id: "a1", parentPath: "systemA" },
        { id: "a2", parentPath: "systemA" },
      ],
      relationships: [],
      expandedIds: ["systemA", "systemB"],
      previousLayout,
    });

    const groupDelta = layout.groupBboxes.get("systemA")!.x - 240;
    const a1Delta = layout.nodeBboxes.get("a1")!.x - 276;
    const a2Delta =
      layout.nodeBboxes.get("a2")!.x -
      (276 + C4_LAYOUT_CARD_WIDTH + C4_LAYOUT_CHILD_COLUMN_GAP);

    expect(groupDelta).toBeGreaterThan(0);
    expect(a1Delta).toBe(groupDelta);
    expect(a2Delta).toBe(groupDelta);
  });

  it("drops descendant boxes when the projection no longer includes them", () => {
    const expandedLayout = layoutInlineC4({
      nodes: [
        { id: "system", children: ["containerA"] },
        { id: "containerA", parentPath: "system" },
      ],
      relationships: [],
      expandedIds: ["system"],
    });

    const collapsedLayout = layoutInlineC4({
      nodes: [{ id: "system" }],
      relationships: [],
      expandedIds: [],
      previousLayout: expandedLayout,
    });

    expect(collapsedLayout.nodeBboxes.has("containerA")).toBe(false);
    expect(collapsedLayout.groupBboxes.has("system")).toBe(false);
    expect(collapsedLayout.nodeBboxes.has("system")).toBe(true);
  });
});

describe("createC4ChildLayoutKey", () => {
  it("changes when children or child relationship signatures change", () => {
    const base = createC4ChildLayoutKey(
      "system",
      ["a", "b"],
      [{ kind: "semantic", from: "a", to: "b", semanticKind: "reads" }],
    );
    const changedRelationship = createC4ChildLayoutKey(
      "system",
      ["a", "b"],
      [{ kind: "semantic", from: "a", to: "b", semanticKind: "writes" }],
    );
    const changedChildren = createC4ChildLayoutKey(
      "system",
      ["a", "b", "c"],
      [{ kind: "semantic", from: "a", to: "b", semanticKind: "reads" }],
    );

    expect(changedRelationship).not.toBe(base);
    expect(changedChildren).not.toBe(base);
  });
});

function previousBoxes(input: {
  nodeBboxes: Record<
    string,
    { x: number; y: number; width: number; height: number }
  >;
  groupBboxes?: Record<
    string,
    { x: number; y: number; width: number; height: number }
  >;
}): C4LayoutResult {
  return {
    nodeBboxes: new Map(Object.entries(input.nodeBboxes)),
    groupBboxes: new Map(Object.entries(input.groupBboxes ?? {})),
    childLayoutKeys: new Map(),
  };
}
