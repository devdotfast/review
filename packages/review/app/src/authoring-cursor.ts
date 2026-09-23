import type {
  ActivitySnapshot,
  LeaseScope,
} from "../../src/review-api/activity";
import type { EditSummary } from "../../src/review-api/document";

/**
 * Where the agent is on the board. The stream carries two signals: the edit
 * that produced each version, and the lease's focus. A new version moves the
 * cursor to what it edited; between versions, a changed focus moves it to
 * what the agent says it is looking at. `seq` counts moves, so two edits to
 * the same target still read as two arrivals. A reader who joins mid-session
 * finds him standing on the last edit, already drawn.
 *
 * Each lease scope has its own cursor: the document's courier follows
 * document edits and the document lease's focus, the Diffs page's follows
 * lens edits and the lenses lease's focus. One stream feeds both.
 */
export interface AuthoringCursor {
  targetId: string;
  /** The block the target belongs to: itself, or a unit's diagram. */
  blockId: string;
  /** `standing`: the edit was on the board before the reader arrived, so
   * the courier stands on it and nothing is drawn. */
  source: "edit" | "focus" | "standing";
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

/** The scope an edit belongs to: a lens edit is the lenses lease's work. */
export const editScope = (edit: EditSummary): LeaseScope =>
  edit.kind === "lens" ? "lenses" : "document";

/** The focus of one scope's lease; a focus without a scope is the document's. */
export function scopeFocus(activity: ActivitySnapshot, scope: LeaseScope) {
  return activity.focuses?.find(
    (focus) => (focus.scope ?? "document") === scope,
  );
}

/** Whether one scope's lease is live. A host that predates scopes reports
 * only a count, which is the document's. */
export function scopeLive(
  activity: ActivitySnapshot | "unknown" | undefined,
  scope: LeaseScope,
): boolean {
  if (activity === undefined || activity === "unknown") return false;

  return activity.scopes
    ? activity.scopes.includes(scope)
    : scope === "document" && activity.workingCount > 0;
}

/** Fold one stream message into one scope's cursor; the memory is the
 * caller's, one per scope. */
export function nextCursor(
  cursor: AuthoringCursor | null,
  memory: CursorMemory,
  message: CursorMessage,
  scope: LeaseScope = "document",
): AuthoringCursor | null {
  const seq = (cursor?.seq ?? 0) + 1;

  const focusTarget =
    message.activity === "unknown"
      ? memory.focusTarget
      : scopeFocus(message.activity, scope)?.targetId;

  // Another scope's edit is not this courier's to draw.
  const lastEdit =
    message.lastEdit && editScope(message.lastEdit) === scope
      ? message.lastEdit
      : undefined;

  const first = memory.version === undefined;
  const versionChanged = !first && memory.version !== message.version;

  memory.version = message.version;

  // The document as found: the courier starts on its last edit, unless the
  // agent already names what it is looking at.
  if (first && lastEdit && !focusTarget)
    return {
      targetId: lastEdit.targetId,
      blockId: lastEdit.blockId,
      source: "standing",
      edit: lastEdit,
      seq,
    };

  if (versionChanged && lastEdit) {
    // The edit has the agent's attention: a focus set before it is spent.
    memory.focusTarget = focusTarget;

    return {
      targetId: lastEdit.targetId,
      blockId: lastEdit.blockId,
      source: "edit",
      edit: lastEdit,
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
