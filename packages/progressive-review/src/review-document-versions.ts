import type { ReviewDocumentVersionWire } from "@dev.fast/review-protocol";

import type { StoredReview } from "./review-home";
import { reviewVcs } from "./review-vcs";

export const REVIEW_PUBLISH_CANDIDATE_MESSAGE = "Review publish candidate";

/** Published document versions, newest first. */
export async function listReviewDocumentVersions(
  review: StoredReview,
): Promise<ReviewDocumentVersionWire[]> {
  const current = review.review.presentedDocumentRevision;
  if (!current) return [];
  // Only revisions the desktop actually promoted are reviewer-visible. A
  // sealed candidate that never reached promotion (a `review publish` that
  // failed between seal and the `/publish-ready` round-trip) stays in the
  // review VCS but must not surface as a published version. Reviews promoted
  // before `promotedDocumentRevisions` was recorded fall back to the single
  // presented revision, which is always a real promotion.
  const promoted = new Set(
    review.review.promotedDocumentRevisions ?? [current],
  );
  const entries = await reviewVcs.log(review.dir);
  return entries
    .filter((entry) => promoted.has(entry.oid))
    .map((entry) => ({
      revision: entry.oid,
      sealedAt: entry.timestamp * 1000,
      isCurrent: entry.oid === current,
    }));
}

/**
 * Returns the `promotedDocumentRevisions` list after promoting `revision`,
 * without mutating `stored`. When the field is already recorded, the new
 * revision is appended (deduplicated). When it is absent — a review promoted
 * before this field existed — the list is seeded from the previously-presented
 * revision (which was a real promotion) alongside the new one, so the prior
 * published version is preserved in history rather than dropped.
 */
export function appendPromotedDocumentRevision(
  stored: StoredReview,
  revision: string,
): string[] {
  const recorded = stored.review.promotedDocumentRevisions;
  if (recorded && recorded.length > 0) {
    return recorded.includes(revision) ? recorded : [...recorded, revision];
  }
  const previouslyPresented = stored.review.presentedDocumentRevision;
  return previouslyPresented && previouslyPresented !== revision
    ? [previouslyPresented, revision]
    : [revision];
}
