import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DISMISSED_RETENTION_DAYS } from "@dev.fast/review-protocol";

import type { DismissedRetentionDays } from "./review-attention";
import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

/**
 * Machine-wide Review preferences the server itself needs. Workbench settings
 * do not work here: the reaper runs in the review server, which never reads
 * the workbench configuration.
 */
export interface ReviewPreferences {
  /** `null` means never reap. */
  dismissedRetentionDays: DismissedRetentionDays;
}

export const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  dismissedRetentionDays: DEFAULT_DISMISSED_RETENTION_DAYS,
};

export function reviewPreferencesPath(devHome = devReviewHome()): string {
  return path.join(devHome, "preferences.json");
}

/** A missing or unreadable file falls back to the defaults; it never throws. */
export async function readReviewPreferences(
  devHome?: string,
): Promise<ReviewPreferences> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(reviewPreferencesPath(devHome), "utf8"),
    );
    return { dismissedRetentionDays: parseRetentionDays(raw) };
  } catch {
    return { ...DEFAULT_REVIEW_PREFERENCES };
  }
}

export async function writeReviewPreferences(
  preferences: ReviewPreferences,
  devHome?: string,
): Promise<ReviewPreferences> {
  const next: ReviewPreferences = {
    dismissedRetentionDays: normalizeRetentionDays(
      preferences.dismissedRetentionDays,
    ),
  };
  await writePrivateJsonAtomic(reviewPreferencesPath(devHome), next);
  return next;
}

function parseRetentionDays(raw: unknown): DismissedRetentionDays {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_DISMISSED_RETENTION_DAYS;
  }
  const value = (raw as Record<string, unknown>).dismissedRetentionDays;
  if (value === null) return null;
  return normalizeRetentionDays(typeof value === "number" ? value : undefined);
}

/**
 * Guards the reaper against a hand-edited file: a zero or negative window would
 * delete every dismissed review on the next scan.
 */
function normalizeRetentionDays(value: unknown): DismissedRetentionDays {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_DISMISSED_RETENTION_DAYS;
  }
  return Math.floor(value);
}
