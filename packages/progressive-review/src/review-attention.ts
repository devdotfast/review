import type { ReviewRecord } from "@dev.fast/review-protocol";

import {
  type StoredReview,
  type StoredReviewRecord,
  persistStoredReviewRecord,
} from "./review-home";

/**
 * The reader-facing lifecycle: new -> viewed -> dismissed. It is a separate
 * axis from `status`, which tracks the agent handoff. A review carries both.
 *
 * Dismissal is reversible until the reaper deletes the review. Closing a review
 * tab is not dismissal and must never write these fields.
 */

/** `null` turns reaping off: a dismissed review then waits forever. */
export type DismissedRetentionDays = number | null;

const DAY_MS = 86_400_000;

export async function writeReviewRecord(
  stored: StoredReview,
  patch: Partial<StoredReviewRecord>,
): Promise<StoredReview> {
  const review: StoredReviewRecord = { ...stored.review, ...patch };
  await persistStoredReviewRecord(stored.dir, review);
  return { ...stored, review };
}

/**
 * Stamps the first read. Later opens keep the original timestamp, so "viewed"
 * means "you have seen this at all", not "you saw it most recently".
 */
export async function markReviewViewed(
  stored: StoredReview,
  now = new Date(),
): Promise<StoredReview> {
  if (stored.review.viewedAt) return stored;
  return writeReviewRecord(stored, { viewedAt: now.toISOString() });
}

export async function dismissReview(
  stored: StoredReview,
  now = new Date(),
): Promise<StoredReview> {
  if (stored.review.dismissedAt) return stored;
  return writeReviewRecord(stored, { dismissedAt: now.toISOString() });
}

/** Undo. Clearing the stamp also stops the reap clock. */
export async function restoreReview(
  stored: StoredReview,
): Promise<StoredReview> {
  if (!stored.review.dismissedAt) return stored;
  return writeReviewRecord(stored, { dismissedAt: null });
}

/**
 * A publish means the agent produced new work, so the review earns the reader's
 * attention again and comes back as new. This also rescues a review that was
 * dismissed and then updated instead of dropped.
 */
export async function resetReviewAttention(
  stored: StoredReview,
): Promise<StoredReview> {
  if (!stored.review.viewedAt && !stored.review.dismissedAt) return stored;
  return writeReviewRecord(stored, { viewedAt: null, dismissedAt: null });
}

/** Absolute deadline, so a client can count down without knowing the setting. */
export function reviewReapsAt(
  review: Pick<ReviewRecord, "dismissedAt">,
  retentionDays: DismissedRetentionDays,
): string | null {
  if (!review.dismissedAt || retentionDays === null) return null;
  const dismissed = Date.parse(review.dismissedAt);
  if (!Number.isFinite(dismissed)) return null;
  return new Date(dismissed + retentionDays * DAY_MS).toISOString();
}

export function isReviewReapable(
  review: Pick<ReviewRecord, "dismissedAt">,
  retentionDays: DismissedRetentionDays,
  now = new Date(),
): boolean {
  const reapsAt = reviewReapsAt(review, retentionDays);
  return reapsAt !== null && Date.parse(reapsAt) <= now.getTime();
}

/**
 * Selects the reviews whose retention window has closed. The caller deletes
 * them, so this stays free of file-system effects and is directly testable.
 */
export function selectReapableReviews(
  reviews: readonly StoredReview[],
  retentionDays: DismissedRetentionDays,
  now = new Date(),
): StoredReview[] {
  if (retentionDays === null) return [];
  return reviews.filter((stored) =>
    isReviewReapable(stored.review, retentionDays, now),
  );
}
