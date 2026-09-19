import { describe, expect, it } from "vitest";

import {
  activeTargetForScroll,
  scrollTailHeight,
} from "./scroll-active-tracking";

const targets = [
  { id: "a", top: -400 },
  { id: "b", top: 120 },
  { id: "c", top: 900 },
];

describe("activeTargetForScroll", () => {
  it("keeps the previous target until the candidate enters the top half", () => {
    expect(activeTargetForScroll(targets, 0, 300)).toBe("b");
    expect(
      activeTargetForScroll(
        [targets[0]!, { id: "b", top: 500 }, targets[2]!],
        0,
        300,
      ),
    ).toBe("a");
  });

  it("holds the first target at scroll zero and the last past every target", () => {
    expect(
      activeTargetForScroll(
        [
          { id: "a", top: 0 },
          { id: "b", top: 40 },
        ],
        0,
        300,
      ),
    ).toBe("a");
    expect(
      activeTargetForScroll(
        [
          { id: "a", top: -900 },
          { id: "b", top: -200 },
        ],
        0,
        300,
      ),
    ).toBe("b");
    expect(activeTargetForScroll([], 0, 300)).toBeNull();
  });
});

describe("scrollTailHeight", () => {
  it("grants exactly the room the last target needs to reach the active line", () => {
    expect(
      scrollTailHeight({
        lastTargetTop: 2000,
        slack: 20,
        viewportHeight: 800,
        contentHeightSansTail: 2400,
      }),
    ).toBe(380);
    expect(
      scrollTailHeight({
        lastTargetTop: 100,
        slack: 20,
        viewportHeight: 800,
        contentHeightSansTail: 2400,
      }),
    ).toBe(0);
  });
});
