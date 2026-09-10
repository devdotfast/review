import type { ReviewDocumentVersionWire } from "@dev.fast/review-protocol";

import type { StoredReview } from "./review-home";
import { listPublications } from "./review-state-db";

/** Published document versions, newest first. Every row is a committed
 * activation, so the row set is the history; reading a Review imports its
 * Git-era publications first, so a published Review always has rows. */
export async function listReviewDocumentVersions(
  review: StoredReview,
): Promise<ReviewDocumentVersionWire[]> {
  const current = review.review.presentedDocumentRevision;
  if (!current) return [];
  return listPublications(review.dir, "document").map((row) => ({
    revision: row.publicationId,
    sealedAt: Date.parse(row.createdAt),
    isCurrent: row.publicationId === current,
  }));
}
