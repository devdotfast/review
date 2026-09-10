import type { ReviewRecord } from "@dev.fast/review-protocol";

/**
 * How a presentation session relates to the stored review.
 *
 * `live` presents the review's own writable state. The other two present a record the
 * session must not write: a sealed historical revision, and a repair candidate that stays
 * read-only until the server promotes it.
 */
export type ReviewSessionMode =
  | { kind: "live" }
  | { kind: "historical"; revision: string; record: ReviewRecord }
  | {
      kind: "repairValidation";
      record: ReviewRecord;
      isPromoted: () => boolean;
    };

export const LIVE_REVIEW_SESSION_MODE: ReviewSessionMode = { kind: "live" };

/** The record a read-only session presents, or undefined for a live session. */
export function reviewSessionModeRecord(
  mode: ReviewSessionMode,
): ReviewRecord | undefined {
  return mode.kind === "live" ? undefined : mode.record;
}

/** True while the session must reject writes. */
export function reviewSessionModeIsReadOnly(mode: ReviewSessionMode): boolean {
  if (mode.kind === "live") return false;
  if (mode.kind === "historical") return true;
  return !mode.isPromoted();
}
