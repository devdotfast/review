import { readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import {
  DEFAULT_DISMISSED_RETENTION_DAYS,
  type JsonValue,
  isJsonObject,
  jsonNumber,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";

import type { DismissedRetentionDays } from "./whiteboard-attention";
import { devWhiteboardHome } from "./whiteboard-home-paths";

/**
 * Machine-wide Review preferences the server itself needs. Workbench settings
 * do not work here: the reaper runs in the review server, which never reads
 * the workbench configuration, and `review install` runs with no workbench
 * at all.
 */
export interface WhiteboardPreferences {
  /** `null` means never reap. */
  dismissedRetentionDays: DismissedRetentionDays;
  /**
   * Whether the scratchpad exists on this machine. Off, the server neither
   * makes nor lists it and the scratchpad skill is not installed for agents.
   */
  scratchpadEnabled: boolean;
}

const DEFAULT_WHITEBOARD_PREFERENCES: WhiteboardPreferences = {
  dismissedRetentionDays: DEFAULT_DISMISSED_RETENTION_DAYS,
  scratchpadEnabled: false,
};

function whiteboardPreferencesPath(devHome = devWhiteboardHome()): string {
  return path.join(devHome, "preferences.json");
}

/** A missing or unreadable file falls back to the defaults; it never throws. */
export async function readWhiteboardPreferences(
  devHome?: string,
): Promise<WhiteboardPreferences> {
  try {
    const raw = parseJsonText(
      await readFile(whiteboardPreferencesPath(devHome), "utf8"),
    );

    return {
      dismissedRetentionDays: parseRetentionDays(raw),
      scratchpadEnabled: parseScratchpadEnabled(raw),
    };
  } catch {
    return { ...DEFAULT_WHITEBOARD_PREFERENCES };
  }
}

export async function writeWhiteboardPreferences(
  preferences: WhiteboardPreferences,
  devHome?: string,
): Promise<WhiteboardPreferences> {
  const next: WhiteboardPreferences = {
    dismissedRetentionDays: normalizeRetentionDays(
      preferences.dismissedRetentionDays,
    ),
    scratchpadEnabled: preferences.scratchpadEnabled === true,
  };

  await writePrivateJsonAtomic(whiteboardPreferencesPath(devHome), next);

  return next;
}

/** Reads the scratchpad preference; a missing file means off. */
export async function readScratchpadEnabled(
  devHome?: string,
): Promise<boolean> {
  return (await readWhiteboardPreferences(devHome)).scratchpadEnabled;
}

/** Sets the scratchpad preference, keeping the other preferences as they are. */
export async function writeScratchpadEnabled(
  enabled: boolean,
  devHome?: string,
): Promise<boolean> {
  const current = await readWhiteboardPreferences(devHome);

  return (
    await writeWhiteboardPreferences(
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
