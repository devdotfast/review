import type { StoredReviewRecord } from "./review-home";

export type ReviewSourcePins = Pick<
  StoredReviewRecord,
  "baseRef" | "baseCommit" | "sourceCommit" | "sourceIdentity"
>;

/** Sealed presentations retain their source even when editable pins move. */
export function reviewSourcePins(record: ReviewSourcePins): ReviewSourcePins {
  return {
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    sourceCommit: record.sourceCommit,
    sourceIdentity: record.sourceIdentity,
  };
}
