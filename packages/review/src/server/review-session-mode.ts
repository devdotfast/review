import type { ReviewRecord } from "@dev.fast/review-protocol";

/**
 * How a presentation session relates to the stored review.
 *
 * `live` presents the review's own writable state. `historical` presents a sealed
 * revision the session must not write.
 */
export type ReviewSessionMode =
  | { kind: "live" }
  | { kind: "historical"; revision: string; record: ReviewRecord };

/** Absent when the artifact is available; otherwise the reason to show the reader. */
export interface ReviewSessionArtifacts {
  document?: string;
  map?: string;
  source?: string;
}

export const LIVE_REVIEW_SESSION_MODE: ReviewSessionMode = { kind: "live" };

/** The record a read-only session presents, or undefined for a live session. */
export function reviewSessionModeRecord(
  mode: ReviewSessionMode,
): ReviewRecord | undefined {
  return mode.kind === "live" ? undefined : mode.record;
}

/** True while the session must reject writes. */
export function reviewSessionModeIsReadOnly(mode: ReviewSessionMode): boolean {
  return mode.kind !== "live";
}
