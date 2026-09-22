import { describe, expect, it } from "vitest";

import type { AuthoringCursor } from "./authoring-cursor";
import {
  EMPTY_QUEUE,
  WHOLE_THRESHOLD,
  arrive,
  nextDue,
  phases,
  standingCursor,
  tick,
} from "./draw-queue";

let seq = 0;

const node = (id: string, diagram = "diagram-1"): AuthoringCursor => ({
  targetId: id,
  blockId: diagram,
  source: "edit",
  edit: { type: "insert", targetId: id, blockId: diagram, unit: "flow_node" },
  seq: ++seq,
});

const block = (id: string): AuthoringCursor => ({
  targetId: id,
  blockId: id,
  source: "edit",
  edit: { type: "insert", targetId: id, blockId: id },
  seq: ++seq,
});

const focus = (id: string): AuthoringCursor => ({
  targetId: id,
  blockId: id,
  source: "focus",
  seq: ++seq,
});

describe("draw queue", () => {
  it("draws arrivals one at a time, phase by phase, and stands on the last one", () => {
    let state = arrive(EMPTY_QUEUE, node("node-1"), 0);
    state = arrive(state, node("node-2"), 10);
    state = arrive(state, block("block-3"), 20);

    expect(standingCursor(state)?.targetId).toBe("node-1");
    expect(phases(state)).toEqual(
      new Map([
        ["node-1", "outline"],
        ["node-2", "queued"],
        ["block-3", "queued"],
      ]),
    );
    expect(nextDue(state)).toBe(420);

    state = tick(state, 420);
    expect(phases(state).get("node-1")).toBe("fill");
    expect(nextDue(state)).toBe(750);

    state = tick(state, 750);
    expect(standingCursor(state)?.targetId).toBe("node-2");
    expect(phases(state).get("node-1")).toBeUndefined();

    // A late tick finishes everything that was due by then.
    state = tick(state, 750 + 750 + 680);
    expect(state.head).toBeNull();
    expect(standingCursor(state)?.targetId).toBe("block-3");
    expect(phases(state).size).toBe(0);
    expect(nextDue(state)).toBeNull();
  });

  it("holds a focus until the next arrival, which takes over at once", () => {
    let state = arrive(EMPTY_QUEUE, focus("block-1"), 0);
    expect(phases(state).get("block-1")).toBe("attention");
    expect(nextDue(state)).toBeNull();

    state = tick(state, 10_000);
    expect(phases(state).get("block-1")).toBe("attention");

    state = arrive(state, block("block-2"), 10_000);
    expect(phases(state)).toEqual(new Map([["block-2", "landing"]]));
    expect(standingCursor(state)?.targetId).toBe("block-2");

    // A focus behind edits waits its turn, then holds.
    state = arrive(state, focus("block-3"), 10_000);
    expect(phases(state).get("block-3")).toBeUndefined();
    state = tick(state, 10_680);
    expect(phases(state).get("block-3")).toBe("attention");
  });

  it("lands a burst of units for one diagram as the whole diagram", () => {
    let state = EMPTY_QUEUE;
    state = arrive(state, block("block-0"), 0);

    for (let i = 1; i <= WHOLE_THRESHOLD + 1; i++)
      state = arrive(state, node(`node-${i}`), i);

    state = arrive(state, node("other-1", "diagram-2"), 100);

    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]).toMatchObject({
      whole: true,
      cursor: { targetId: "diagram-1", blockId: "diagram-1" },
    });
    expect(state.pending[1]!.cursor.targetId).toBe("other-1");

    state = tick(state, 680);
    expect(phases(state).get("diagram-1")).toBe("landing");
    expect(standingCursor(state)?.targetId).toBe("diagram-1");
  });

  it("erases a removed block on the board, and only visits a removed unit", () => {
    const removed = (id: string, unit?: "flow_node"): AuthoringCursor => ({
      targetId: id,
      blockId: unit ? "diagram-1" : id,
      source: "edit",
      edit: {
        type: "remove",
        targetId: id,
        blockId: unit ? "diagram-1" : id,
        unit,
      },
      seq: ++seq,
    });

    let state = arrive(EMPTY_QUEUE, removed("block-1"), 0);
    expect(phases(state).get("block-1")).toBe("erasing");
    expect(nextDue(state)).toBe(660);

    state = arrive(state, removed("node-2", "flow_node"), 0);
    state = tick(state, 660);
    expect(phases(state).size).toBe(0);
    expect(standingCursor(state)?.targetId).toBe("node-2");
  });

  it("keeps a burst at the threshold node by node", () => {
    let state = EMPTY_QUEUE;

    for (let i = 1; i <= WHOLE_THRESHOLD; i++)
      state = arrive(state, node(`node-${i}`), i);

    expect(state.pending).toHaveLength(WHOLE_THRESHOLD - 1);
    expect(state.pending.every((entry) => !entry.whole)).toBe(true);
  });

  it("plays every phase instantly with reduced motion, still in order", () => {
    let state = arrive(EMPTY_QUEUE, node("node-1"), 0, true);
    state = arrive(state, block("block-2"), 0, true);
    expect(nextDue(state)).toBe(0);
    state = tick(state, 0);
    expect(state.head).toBeNull();
    expect(standingCursor(state)?.targetId).toBe("block-2");
  });
});
