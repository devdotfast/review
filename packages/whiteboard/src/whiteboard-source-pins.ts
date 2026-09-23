import type { StoredWhiteboardRecord } from "./whiteboard-home";

export type WhiteboardSourcePins = Pick<
  StoredWhiteboardRecord,
  "baseRef" | "baseCommit" | "sourceCommit" | "sourceIdentity"
>;

/** Sealed presentations retain their source even when editable pins move. */
export function whiteboardSourcePins(
  record: WhiteboardSourcePins,
): WhiteboardSourcePins {
  return {
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    sourceCommit: record.sourceCommit,
    sourceIdentity: record.sourceIdentity,
  };
}
