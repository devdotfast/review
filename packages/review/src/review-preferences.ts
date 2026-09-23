import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DISMISSED_RETENTION_DAYS,
  type JsonValue,
  isJsonObject,
  jsonNumber,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { writePrivateJsonAtomic } from "@dev.fast/trace-core";

import type { DismissedRetentionDays } from "./review-attention";
import { devReviewHome } from "./review-home-paths";

/**
 * Machine-wide Review preferences the server itself needs. Workbench settings
 * do not work here: the reaper runs in the review server, which never reads
 * the workbench configuration, and `review install` runs with no workbench
 * at all.
 */
export interface ReviewPreferences {
  /** `null` means never reap. */
  dismissedRetentionDays: DismissedRetentionDays;
  /**
   * Whether the scratchpad exists on this machine. Off, the server neither
   * makes nor lists it and the scratchpad skill is not installed for agents.
   */
  scratchpadEnabled: boolean;
}

const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  dismissedRetentionDays: DEFAULT_DISMISSED_RETENTION_DAYS,
  scratchpadEnabled: false,
};

function reviewPreferencesPath(devHome = devReviewHome()): string {
  return path.join(devHome, "preferences.json");
}

/** A missing or unreadable file falls back to the defaults; it never throws. */
export async function readReviewPreferences(
  devHome?: string,
): Promise<ReviewPreferences> {
  try {
    const raw = parseJsonText(
      await readFile(reviewPreferencesPath(devHome), "utf8"),
    );

    return {
      dismissedRetentionDays: parseRetentionDays(raw),
      scratchpadEnabled: parseScratchpadEnabled(raw),
    };
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
    scratchpadEnabled: preferences.scratchpadEnabled === true,
  };

  await writePrivateJsonAtomic(reviewPreferencesPath(devHome), next);

  return next;
}

/** Reads the scratchpad preference; a missing file means off. */
export async function readScratchpadEnabled(
  devHome?: string,
): Promise<boolean> {
  return (await readReviewPreferences(devHome)).scratchpadEnabled;
}

/** Sets the scratchpad preference, keeping the other preferences as they are. */
export async function writeScratchpadEnabled(
  enabled: boolean,
  devHome?: string,
): Promise<boolean> {
  const current = await readReviewPreferences(devHome);

  return (
    await writeReviewPreferences(
      { ...current, scratchpadEnabled: enabled },
      devHome,
    )
  ).scratchpadEnabled;
}

function parseScratchpadEnabled(raw: JsonValue): boolean {
  return isJsonObject(raw) && raw.scratchpadEnabled === true;
}

function parseRetentionDays(raw: JsonValue): DismissedRetentionDays {
  if (!isJsonObject(raw)) {
    return DEFAULT_DISMISSED_RETENTION_DAYS;
  }

  const value = raw.dismissedRetentionDays;

  if (value === null) return null;

  return normalizeRetentionDays(jsonNumber(value));
}

/**
 * Guards the reaper against a hand-edited file: a zero or negative window would
 * delete every dismissed review on the next scan.
 */
function normalizeRetentionDays(
  value: number | null | undefined,
): DismissedRetentionDays {
  if (value === null) return null;

  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_DISMISSED_RETENTION_DAYS;
  }

  return Math.floor(value);
}
