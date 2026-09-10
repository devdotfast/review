import type { ReviewDocumentVersionWire } from "@dev.fast/review-protocol";

import { LEGACY_PUBLISH_CANDIDATE_MESSAGE } from "./legacy-review-import";
import type { StoredReview } from "./review-home";
import { listPublications } from "./review-state-db";
import { reviewVcs } from "./review-vcs";

/** Published document versions, newest first. Every row is a committed
 * activation, so the row set is the history; a Git-era review with no rows
 * still reads its private history. */
export async function listReviewDocumentVersions(
  review: StoredReview,
): Promise<ReviewDocumentVersionWire[]> {
  const current = review.review.presentedDocumentRevision;
  if (!current) return [];
  const rows = listPublications(review.dir, "document");
  if (rows.length === 0) return listLegacyReviewDocumentVersions(review);
  return rows.map((row) => ({
    revision: row.publicationId,
    sealedAt: Date.parse(row.createdAt),
    isCurrent: row.publicationId === current,
  }));
}

/** The Git-era listing, retired with the last unimported review. */
export async function listLegacyReviewDocumentVersions(
  review: StoredReview,
): Promise<ReviewDocumentVersionWire[]> {
  const current = review.review.presentedDocumentRevision;
  const entries = await reviewVcs.log(review.dir);
  const currentIndex = entries.findIndex((entry) => entry.oid === current);
  const presented = currentIndex === -1 ? entries : entries.slice(currentIndex);
  return presented
    .filter(
      (entry) =>
        entry.message === LEGACY_PUBLISH_CANDIDATE_MESSAGE ||
        entry.oid === current,
    )
    .map((entry) => ({
      revision: entry.oid,
      sealedAt: entry.timestamp * 1000,
      isCurrent: entry.oid === current,
    }));
}
