import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { reviewDir } from "./review-file";

// A "pending reopen" marker records that the reviewer requested changes that
// have not been republished yet. A successful `review publish` clears it, as do
// reviewer approval and rejection, so it exists only while requested changes
// are waiting to be addressed and republished. The `review stop-hook` nudge
// keeps that loop moving; `review wait` is the deliberate blocking alternative.
const MARKER_FILENAME = "pending-reopen.json";

export const REOPEN_STOP_HOOK_REASON =
  "The reviewer requested changes in the dev.fast Review canvas and the review " +
  "has not been republished yet. Address every open comment in review.mdx (or the " +
  "code). Resolve each addressed thread with `review threads resolve`. List the " +
  "threads again. Then run `review publish --json` only when no open threads remain. " +
  "Use `review wait` when you deliberately want to block for reviewer " +
  "action. The loop ends when the reviewer approves or rejects the review.";

export interface ReopenMarker {
  /** ISO timestamp of the submission event that created the marker. */
  submittedAt: string;
  /**
   * True once the stop hook has already nudged the model to reopen for this
   * exact submission. Prevents an endless block loop if the model declines to
   * reopen — the loop still continues normally across genuine rounds because
   * each reopen clears the marker and each new submission writes a fresh one.
   */
  nudged: boolean;
}

export function reopenMarkerPath(cwd: string): string {
  return path.join(reviewDir(cwd), MARKER_FILENAME);
}

export async function markReopenPending(
  cwd: string,
  submittedAt: string,
): Promise<void> {
  const file = reopenMarkerPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const marker: ReopenMarker = { submittedAt, nudged: false };
  await writeFile(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export async function clearReopenPending(cwd: string): Promise<void> {
  await rm(reopenMarkerPath(cwd), { force: true });
}

export async function readReopenMarker(
  cwd: string,
): Promise<ReopenMarker | null> {
  let raw: string;
  try {
    raw = await readFile(reopenMarkerPath(cwd), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = jsonObject(parseJsonText(raw));
    const submittedAt = jsonString(parsed?.submittedAt);
    if (parsed === undefined || submittedAt === undefined) return null;
    return { submittedAt, nudged: parsed.nudged === true };
  } catch {
    return null;
  }
}

export async function markReopenNudged(
  cwd: string,
  marker: ReopenMarker,
): Promise<void> {
  const nudged: ReopenMarker = { ...marker, nudged: true };
  const content = `${JSON.stringify(nudged, null, 2)}\n`;
  // Open with "r+" so a marker cleared concurrently (e.g. by a parallel
  // `review publish` reopening the canvas) is NOT resurrected — the open fails
  // with ENOENT and we treat the nudge as already resolved. Truncate first so
  // the shorter `"nudged": true` fully overwrites the previous contents.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(reopenMarkerPath(cwd), "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await handle.truncate(0);
    await handle.write(content, 0, "utf8");
  } finally {
    await handle.close();
  }
}

export interface StopHookDecision {
  /** Whether to block the turn from ending and reopen the review. */
  block: boolean;
  /** Reason surfaced to the model when blocking. */
  reason?: string;
  /** Whether the marker should be stamped as nudged after this decision. */
  markNudged: boolean;
}

/**
 * Pure decision for the Stop hook. Blocks (reopens) exactly once per submitted
 * round that has not been reopened; a second consecutive stop for the same
 * un-reopened round is allowed through so the loop can never lock up.
 */
export function decideStopHook(marker: ReopenMarker | null): StopHookDecision {
  if (!marker) return { block: false, markNudged: false };
  if (marker.nudged) return { block: false, markNudged: false };
  return { block: true, reason: REOPEN_STOP_HOOK_REASON, markNudged: true };
}
