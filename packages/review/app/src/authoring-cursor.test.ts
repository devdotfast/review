import { describe, expect, it } from "vitest";

import type { EditSummary } from "../../src/review-api/document";
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

    // The first message is the document as found: the courier stands on its
    // last edit, which was drawn before the reader arrived.
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
    expect(cursor).toMatchObject({
      targetId: "block-1",
      blockId: "block-1",
      source: "standing",
      seq: 1,
    });

    cursor = nextCursor(cursor, memory, {
      version: 3,
      activity: working("block-1"),
    });
    expect(cursor).toMatchObject({
      targetId: "block-1",
      source: "focus",
      seq: 2,
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
      seq: 3,
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

  it("starts on the agent's focus when it names one, and nowhere on an unedited document", () => {
    const lastEdit: EditSummary = {
      type: "insert",
      targetId: "block-1",
      blockId: "block-1",
      kind: "markdown",
    };

    expect(
      nextCursor(null, {}, { version: 3, lastEdit, activity: working("b") }),
    ).toMatchObject({ targetId: "b", source: "focus" });
    expect(
      nextCursor(null, {}, { version: 0, activity: working() }),
    ).toBeNull();
  });
});
