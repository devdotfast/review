import { readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonAtomic } from "@dev.fast/trace-core";

import type { WhiteboardRecord } from "./review-import/legacy-record";
import {
  type StoredWhiteboard,
  type StoredWhiteboardRecord,
  parseStoredWhiteboardRecord,
} from "./whiteboard-home";
import { withWhiteboardMutationLock } from "./whiteboard-mutation-lock";

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

export async function writeWhiteboardRecord(
  stored: StoredWhiteboard,
  patch: Partial<StoredWhiteboardRecord>,
): Promise<StoredWhiteboard> {
  return withWhiteboardMutationLock(stored.dir, async () => {
    const current = parseStoredWhiteboardRecord(
      JSON.parse(await readFile(path.join(stored.dir, "review.json"), "utf8")),
    );

    const review: StoredWhiteboardRecord = { ...current, ...patch };
    await writePrivateJsonAtomic(path.join(stored.dir, "review.json"), review);

    return { ...stored, review };
  });
}

/**
 * Stamps the first read. Later opens keep the original timestamp, so "viewed"
 * means "you have seen this at all", not "you saw it most recently".
 */
export async function markWhiteboardViewed(
  stored: StoredWhiteboard,
  now = new Date(),
): Promise<StoredWhiteboard> {
  if (stored.review.viewedAt) return stored;

  return writeWhiteboardRecord(stored, { viewedAt: now.toISOString() });
}

export async function dismissWhiteboard(
  stored: StoredWhiteboard,
  now = new Date(),
): Promise<StoredWhiteboard> {
  if (stored.review.dismissedAt) return stored;

  return writeWhiteboardRecord(stored, { dismissedAt: now.toISOString() });
}

/** Undo. Clearing the stamp also stops the reap clock. */
export async function restoreWhiteboard(
  stored: StoredWhiteboard,
): Promise<StoredWhiteboard> {
  if (!stored.review.dismissedAt) return stored;

  return writeWhiteboardRecord(stored, { dismissedAt: null });
}

/**
 * A publish means the agent produced new work, so the review earns the reader's
 * attention again and comes back as new. This also rescues a review that was
 * dismissed and then updated instead of dropped.
 */
export async function resetWhiteboardAttention(
  stored: StoredWhiteboard,
): Promise<StoredWhiteboard> {
  if (!stored.review.viewedAt && !stored.review.dismissedAt) return stored;

  return writeWhiteboardRecord(stored, { viewedAt: null, dismissedAt: null });
}

/** Absolute deadline, so a client can count down without knowing the setting. */
export function whiteboardReapsAt(
  review: Pick<WhiteboardRecord, "dismissedAt">,
  retentionDays: DismissedRetentionDays,
): string | null {
  if (!review.dismissedAt || retentionDays === null) return null;
  const dismissed = Date.parse(review.dismissedAt);

  if (!Number.isFinite(dismissed)) return null;

  return new Date(dismissed + retentionDays * DAY_MS).toISOString();
}

export function isWhiteboardReapable(
  review: Pick<WhiteboardRecord, "dismissedAt">,
  retentionDays: DismissedRetentionDays,
  now = new Date(),
): boolean {
  const reapsAt = whiteboardReapsAt(review, retentionDays);

  return reapsAt !== null && Date.parse(reapsAt) <= now.getTime();
}

/**
 * Selects the reviews whose retention window has closed. The caller deletes
 * them, so this stays free of file-system effects and is directly testable.
 */
export function selectReapableWhiteboards(
  reviews: readonly StoredWhiteboard[],
  retentionDays: DismissedRetentionDays,
  now = new Date(),
): StoredWhiteboard[] {
  if (retentionDays === null) return [];

  return reviews.filter((stored) =>
    isWhiteboardReapable(stored.review, retentionDays, now),
  );
}
