import { describe, expect, it } from "vitest";

import type { AuthoringCursor } from "./authoring-cursor";
import {
  EMPTY_QUEUE,
  STROKE_MS,
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
  edit: {
    type: "insert",
    targetId: id,
    blockId: diagram,
    kind: "flow_node",
    unit: "flow_node",
  },
  seq: ++seq,
});

const block = (id: string): AuthoringCursor => ({
  targetId: id,
  blockId: id,
  source: "edit",
  edit: { type: "insert", targetId: id, blockId: id, kind: "markdown" },
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

  it("folds a burst of units for one diagram into one quick pass", () => {
    let state = EMPTY_QUEUE;
    state = arrive(state, block("block-0"), 0);

    for (let i = 1; i <= WHOLE_THRESHOLD + 1; i++)
      state = arrive(state, node(`node-${i}`), i);

    state = arrive(state, node("other-1", "diagram-2"), 100);

    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]).toMatchObject({
      cursor: {
        targetId: "diagram-1",
        blockId: "diagram-1",
        edit: { units: expect.arrayContaining(["node-1", "node-21"]) },
      },
    });
    // Above sixteen units, a stroke takes two at a time.
    expect(state.pending[0]!.steps).toHaveLength(
      Math.ceil((WHOLE_THRESHOLD + 1) / 2),
    );
    expect(state.pending[1]!.cursor.targetId).toBe("other-1");

    state = tick(state, 680);
    expect(phases(state).get("node-1")).toBe("stroke");
    expect(phases(state).get("node-2")).toBe("stroke");
    expect(phases(state).get("node-3")).toBe("queued");
    expect(standingCursor(state)?.targetId).toBe("diagram-1");
  });

  it("traces a diagram written whole in one quick pass, unit by unit", () => {
    const units = ["n1", "n2", "e1", "n3", "e2"];

    const whole: AuthoringCursor = {
      targetId: "diagram-1",
      blockId: "diagram-1",
      source: "edit",
      edit: {
        type: "insert",
        targetId: "diagram-1",
        blockId: "diagram-1",
        kind: "flow_diagram",
        units,
      },
      seq: ++seq,
    };

    let state = arrive(EMPTY_QUEUE, block("block-0"), 0);
    state = arrive(state, whole, 0);
    // Waiting its turn: the block and every unit stay unseen.
    expect(phases(state).get("diagram-1")).toBe("queued");
    expect(phases(state).get("n3")).toBe("queued");

    state = tick(state, 680);
    expect(phases(state)).toEqual(
      new Map([
        ["n1", "stroke"],
        ["n2", "queued"],
        ["e1", "queued"],
        ["n3", "queued"],
        ["e2", "queued"],
      ]),
    );
    expect(standingCursor(state)?.targetId).toBe("diagram-1");

    // Each stroke is quick, and the drawn ones stay.
    expect(nextDue(state)).toBe(680 + STROKE_MS);
    state = tick(state, 680 + STROKE_MS * 2);
    expect(phases(state).get("n1")).toBeUndefined();
    expect(phases(state).get("e1")).toBe("stroke");
    expect(phases(state).get("n3")).toBe("queued");

    state = tick(state, 680 + STROKE_MS * 5);
    expect(phases(state).size).toBe(0);
    expect(standingCursor(state)?.targetId).toBe("diagram-1");
  });

  it("draws a node that came with its edge as node, then edge", () => {
    const linked: AuthoringCursor = {
      targetId: "node-3",
      blockId: "diagram-1",
      source: "edit",
      edit: {
        type: "insert",
        targetId: "node-3",
        blockId: "diagram-1",
        kind: "flow_node",
        unit: "flow_node",
        linkId: "edge-4",
      },
      seq: ++seq,
    };

    let state = arrive(EMPTY_QUEUE, node("node-1"), 0);
    state = arrive(state, linked, 0);
    expect(phases(state).get("node-3")).toBe("queued");
    expect(phases(state).get("edge-4")).toBe("queued");

    state = tick(state, 750);
    expect(phases(state).get("node-3")).toBe("outline");
    expect(phases(state).get("edge-4")).toBe("queued");

    state = tick(state, 750 + 420 + 330);
    expect(phases(state).get("node-3")).toBeUndefined();
    expect(phases(state).get("edge-4")).toBe("outline");
    expect(standingCursor(state)?.targetId).toBe("node-3");

    state = tick(state, 750 + 420 + 330 + 450);
    expect(phases(state).size).toBe(0);
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
        kind: unit ?? "markdown",
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

  it("lands a new lens row, relabels a retitle, draws nothing for a targets-only update, and erases a removed row", () => {
    const lens = (
      type: "insert" | "update" | "remove",
      fields?: string[],
    ): AuthoringCursor => ({
      targetId: "lens-3",
      blockId: "lens-3",
      source: "edit",
      edit: {
        type,
        targetId: "lens-3",
        blockId: "lens-3",
        kind: "lens",
        ...(fields && { fields }),
      },
      seq: ++seq,
    });

    const timeline = (cursor: AuthoringCursor) => {
      const seen: (string | undefined)[] = [];
      let state = arrive(EMPTY_QUEUE, cursor, 0);

      for (let due = nextDue(state); due !== null; due = nextDue(state)) {
        seen.push(phases(state).get("lens-3"));
        state = tick(state, due);
      }

      return seen;
    };

    expect(timeline(lens("insert"))).toEqual(["landing"]);
    expect(timeline(lens("update", ["title"]))).toEqual(["relabel"]);
    expect(timeline(lens("update", ["targets"]))).toEqual([]);
    expect(timeline(lens("update", ["title", "targets"]))).toEqual(["relabel"]);
    expect(timeline(lens("remove"))).toEqual(["erasing"]);
  });

  it("draws only what an update changed", () => {
    const update = (
      id: string,
      kind: "section" | "markdown",
      fields: string[],
    ): AuthoringCursor => ({
      targetId: id,
      blockId: id,
      source: "edit",
      edit: { type: "update", targetId: id, blockId: id, kind, fields },
      seq: ++seq,
    });

    // A collapse patch on a section draws nothing and moves nobody.
    let state = arrive(EMPTY_QUEUE, node("node-1"), 0);
    state = tick(state, 750);
    const before = state;
    state = arrive(
      state,
      update("section-1", "section", ["defaultCollapsed"]),
      800,
    );
    expect(state).toBe(before);
    expect(standingCursor(state)?.targetId).toBe("node-1");

    // A retitle recomposes the heading; a section's children are never rewritten.
    state = arrive(state, update("section-1", "section", ["title"]), 800);
    expect(phases(state).get("section-1")).toBe("retitle");
    state = tick(state, 800 + 420);
    state = arrive(
      state,
      update("section-1", "section", ["title", "defaultCollapsed"]),
      1300,
    );
    expect(phases(state).get("section-1")).toBe("retitle");
    state = tick(state, 1300 + 420);

    // Prose that changed is rewritten.
    state = arrive(state, update("block-2", "markdown", ["markdown"]), 2000);
    expect(phases(state).get("block-2")).toBe("rewriting");
  });

  it("keeps a burst at the threshold node by node", () => {
    let state = EMPTY_QUEUE;

    for (let i = 1; i <= WHOLE_THRESHOLD; i++)
      state = arrive(state, node(`node-${i}`), i);

    expect(state.pending).toHaveLength(WHOLE_THRESHOLD - 1);
    expect(state.pending.every((entry) => !entry.cursor.edit?.units)).toBe(
      true,
    );
  });

  it("plays every phase instantly with reduced motion, still in order", () => {
    let state = arrive(EMPTY_QUEUE, node("node-1"), 0, true);
    state = arrive(state, block("block-2"), 0, true);
    expect(nextDue(state)).toBe(0);
    state = tick(state, 0);
    expect(state.head).toBeNull();
    expect(standingCursor(state)?.targetId).toBe("block-2");
  });

  it("stands on an edit drawn before the reader arrived without drawing it", () => {
    const standing: AuthoringCursor = {
      ...block("block-1"),
      source: "standing",
    };

    let state = arrive(EMPTY_QUEUE, standing, 0);
    expect(standingCursor(state)).toBe(standing);
    expect(phases(state).size).toBe(0);
    expect(nextDue(state)).toBeNull();

    // The next edit is drawn as usual, from where he stands.
    state = arrive(state, block("block-2"), 100);
    expect(phases(state)).toEqual(new Map([["block-2", "landing"]]));
    state = tick(state, 780);
    expect(standingCursor(state)?.targetId).toBe("block-2");
  });
});
