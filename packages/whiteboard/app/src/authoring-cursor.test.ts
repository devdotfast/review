import { describe, expect, it } from "vitest";

import type { ActivitySnapshot } from "../../src/session-api/activity";
import type { EditSummary } from "../../src/session-api/document";
import {
  type AuthoringCursor,
  nextCursor,
  scopeLive,
} from "./authoring-cursor";

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

  it("keeps one courier per lease scope, each on its own edits and focus", () => {
    const documentMemory = {},
      lensMemory = {};

    const lensInsert: EditSummary = {
      type: "insert",
      targetId: "lens-4",
      blockId: "lens-4",
      kind: "lens",
    };

    const markdown: EditSummary = {
      type: "insert",
      targetId: "block-1",
      blockId: "block-1",
      kind: "markdown",
    };

    const both = (
      focuses: ActivitySnapshot["focuses"] = [],
    ): ActivitySnapshot => ({
      workingCount: 2,
      expiresAt: null,
      scopes: ["document", "lenses"],
      focuses,
    });

    let documentCursor = nextCursor(null, documentMemory, {
      version: 1,
      lastEdit: markdown,
      activity: both(),
    });

    let lensCursor = nextCursor(
      null,
      lensMemory,
      { version: 1, lastEdit: markdown, activity: both() },
      "lenses",
    );

    expect(documentCursor).toMatchObject({ targetId: "block-1" });
    expect(lensCursor).toBeNull();

    // A lens edit moves only the lenses' courier.
    const lensVersion = { version: 2, lastEdit: lensInsert, activity: both() };
    expect(nextCursor(documentCursor, documentMemory, lensVersion)).toBe(
      documentCursor,
    );
    lensCursor = nextCursor(lensCursor, lensMemory, lensVersion, "lenses");
    expect(lensCursor).toMatchObject({
      targetId: "lens-4",
      source: "edit",
      edit: lensInsert,
    });

    // Each lease's focus moves its own courier.
    const focused = {
      version: 2,
      activity: both([
        { description: "Explaining", targetId: "block-9" },
        { description: "Grouping tests", targetId: "lens-5", scope: "lenses" },
      ]),
    };

    documentCursor = nextCursor(documentCursor, documentMemory, focused);
    lensCursor = nextCursor(lensCursor, lensMemory, focused, "lenses");
    expect(documentCursor).toMatchObject({
      targetId: "block-9",
      source: "focus",
    });
    expect(lensCursor).toMatchObject({ targetId: "lens-5", source: "focus" });
  });

  it("reads a scope as live from the lease scopes, or from a bare count as the document's", () => {
    expect(scopeLive(undefined, "document")).toBe(false);
    expect(scopeLive("unknown", "lenses")).toBe(false);
    expect(
      scopeLive(
        { workingCount: 1, expiresAt: null, scopes: ["lenses"] },
        "document",
      ),
    ).toBe(false);
    expect(
      scopeLive(
        { workingCount: 1, expiresAt: null, scopes: ["lenses"] },
        "lenses",
      ),
    ).toBe(true);
    // A host from before scopes reports only its one lease.
    expect(scopeLive({ workingCount: 1, expiresAt: null }, "document")).toBe(
      true,
    );
    expect(scopeLive({ workingCount: 1, expiresAt: null }, "lenses")).toBe(
      false,
    );
  });
});
