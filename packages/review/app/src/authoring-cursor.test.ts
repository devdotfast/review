import { describe, expect, it } from "vitest";

import { type AuthoringCursor, nextCursor } from "./authoring-cursor";

const working = (targetId?: string) => ({
  workingCount: 1,
  expiresAt: null,
  focuses: targetId ? [{ targetId, description: "Working" }] : [],
});

describe("nextCursor", () => {
  it("moves to what each new version edited, and to a focus set between versions", () => {
    const memory = {};
    let cursor: AuthoringCursor | null = null;

    // The first message is the document as found: nothing was just drawn.
    cursor = nextCursor(cursor, memory, {
      version: 3,
      lastEdit: {
        type: "insert",
        targetId: "block-1",
        blockId: "block-1",
        kind: "markdown",
      },
      activity: working(),
    });
    expect(cursor).toBeNull();

    cursor = nextCursor(cursor, memory, {
      version: 3,
      activity: working("block-1"),
    });
    expect(cursor).toMatchObject({
      targetId: "block-1",
      source: "focus",
      seq: 1,
    });

    // A renewal that keeps the same focus is not a move.
    expect(
      nextCursor(cursor, memory, { version: 3, activity: working("block-1") }),
    ).toBe(cursor);

    cursor = nextCursor(cursor, memory, {
      version: 4,
      lastEdit: {
        type: "insert",
        targetId: "node-7",
        blockId: "diagram-2",
        kind: "flow_node",
        unit: "flow_node",
      },
      activity: working("block-1"),
    });
    expect(cursor).toMatchObject({
      targetId: "node-7",
      blockId: "diagram-2",
      source: "edit",
      seq: 2,
    });

    // The focus that preceded the edit was spent by it; only a new one moves.
    expect(
      nextCursor(cursor, memory, { version: 4, activity: working("block-1") }),
    ).toBe(cursor);
    expect(
      nextCursor(cursor, memory, { version: 4, activity: working("block-9") }),
    ).toMatchObject({ targetId: "block-9", source: "focus" });
  });

  it("stays put through a rename, a cleared focus and a dropped stream", () => {
    const memory = {};

    let cursor = nextCursor(null, {}, { version: 1, activity: working() });
    cursor = nextCursor(cursor, memory, { version: 1, activity: working("b") });
    expect(cursor?.targetId).toBe("b");

    // A version without an edit (rename, repin) leaves the cursor alone.
    expect(
      nextCursor(cursor, memory, { version: 2, activity: working("b") }),
    ).toBe(cursor);
    expect(
      nextCursor(cursor, memory, { version: 2, activity: working() }),
    ).toBe(cursor);
    expect(
      nextCursor(cursor, memory, { version: 2, activity: "unknown" }),
    ).toBe(cursor);
  });
});
