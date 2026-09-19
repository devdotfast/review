import { type CallStackEntry, isCallsAssertion } from "./authoring";
import type { Frame } from "./review-api/document";
import { evidenceLocation } from "./source.js";

/** Legacy call stacks list anchors and `calls()` hops; the document stores
 * canonical frames. The anchor id doubles as the matching key, so a frame
 * shared by both sides still aligns the way anchor identity did. */
export function callStackFrames(entries: readonly CallStackEntry[]): Frame[] {
  return entries.map((entry) => {
    const anchor = isCallsAssertion(entry) ? entry.child : entry;

    const frame: Frame = {
      id: anchor.id,
      key: anchor.id,
      source: anchor.peek,
      label: anchor.title,
    };

    if (isCallsAssertion(entry))
      frame.via = { kind: "call", reason: entry.reason ?? "asserted" };

    return frame;
  });
}

/** Matching identity: an explicit key, else the source range. React and
 * selection identity stay on `id`. */
export function frameIdentity(frame: Frame): string {
  return (
    frame.key ??
    `${evidenceLocation(frame.source).file}:${evidenceLocation(frame.source).fromLine}-${evidenceLocation(frame.source).toLine}`
  );
}

export function frameName(frame: Frame): string {
  return (
    frame.label ??
    frame.key ??
    frame.id ??
    evidenceLocation(frame.source).file.split("/").pop() ??
    evidenceLocation(frame.source).file
  );
}
