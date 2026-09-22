import type { ActivitySnapshot } from "../../src/review-api/activity";
import type { EditSummary } from "../../src/review-api/document";

/**
 * Where the agent is on the board. The stream carries two signals: the edit
 * that produced each version, and the lease's focus. A new version moves the
 * cursor to what it edited; between versions, a changed focus moves it to
 * what the agent says it is looking at. `seq` counts moves, so two edits to
 * the same target still read as two arrivals.
 */
export interface AuthoringCursor {
  targetId: string;
  /** The block the target belongs to: itself, or a unit's diagram. */
  blockId: string;
  source: "edit" | "focus";
  edit?: EditSummary;
  seq: number;
}

export interface CursorMessage {
  version: number;
  lastEdit?: EditSummary;
  activity: ActivitySnapshot | "unknown";
}

/** What the fold remembers between messages; the caller keeps one per stream. */
export interface CursorMemory {
  version?: number;
  focusTarget?: string;
}

/** Fold one stream message into the cursor; the memory is the caller's. */
export function nextCursor(
  cursor: AuthoringCursor | null,
  memory: CursorMemory,
  message: CursorMessage,
): AuthoringCursor | null {
  const seq = (cursor?.seq ?? 0) + 1;

  const focusTarget =
    message.activity === "unknown"
      ? memory.focusTarget
      : message.activity.focuses?.[0]?.targetId;

  const versionChanged =
    memory.version !== undefined && memory.version !== message.version;

  memory.version = message.version;

  if (versionChanged && message.lastEdit) {
    // The edit has the agent's attention: a focus set before it is spent.
    memory.focusTarget = focusTarget;

    return {
      targetId: message.lastEdit.targetId,
      blockId: message.lastEdit.blockId,
      source: "edit",
      edit: message.lastEdit,
      seq,
    };
  }

  if (focusTarget !== memory.focusTarget) {
    memory.focusTarget = focusTarget;

    if (focusTarget)
      return {
        targetId: focusTarget,
        blockId: focusTarget,
        source: "focus",
        seq,
      };
  }

  return cursor;
}
