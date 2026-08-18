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
  const entries = await reviewVcs.log(review.dir);
  const currentIndex = entries.findIndex((entry) => entry.oid === current);
  const presented = currentIndex === -1 ? entries : entries.slice(currentIndex);
  return presented
    .filter(
      (entry) =>
        entry.message === REVIEW_PUBLISH_CANDIDATE_MESSAGE ||
        entry.oid === current,
    )
    .map((entry) => ({
      revision: entry.oid,
      sealedAt: entry.timestamp * 1000,
      isCurrent: entry.oid === current,
    }));
}
