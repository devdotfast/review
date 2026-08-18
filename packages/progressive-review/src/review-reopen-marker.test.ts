import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewDir } from "./review-file";
import {
  REOPEN_STOP_HOOK_REASON,
  type ReopenMarker,
  clearReopenPending,
  decideStopHook,
  markReopenNudged,
  markReopenPending,
  readReopenMarker,
  reopenMarkerPath,
} from "./review-reopen-marker";

describe("decideStopHook", () => {
  it("does not block when there is no pending round", () => {
    expect(decideStopHook(null)).toEqual({ block: false, markNudged: false });
  });

  it("blocks and nudges once for a fresh submitted round", () => {
    const marker: ReopenMarker = {
      submittedAt: "2026-07-01T00:00:00Z",
      nudged: false,
    };
    expect(decideStopHook(marker)).toEqual({
      block: true,
      reason: REOPEN_STOP_HOOK_REASON,
      markNudged: true,
    });
  });

  it("stops blocking once the round has already been nudged (no lockup)", () => {
    const marker: ReopenMarker = {
      submittedAt: "2026-07-01T00:00:00Z",
      nudged: true,
    };
    expect(decideStopHook(marker)).toEqual({ block: false, markNudged: false });
  });
});

describe("reopen marker lifecycle", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  async function tempRepo(): Promise<string> {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "reopen-marker-"));
    cleanupPaths.push(rootPath);
    vi.stubEnv("DEV_REVIEW_HOME", path.join(rootPath, ".dev-home"));
    return path.join(rootPath, "repo");
  }

  it("returns null when no marker exists", async () => {
    const cwd = await tempRepo();
    expect(await readReopenMarker(cwd)).toBeNull();
  });

  it("writes an un-nudged marker under the review dir on submit", async () => {
    const cwd = await tempRepo();
    await markReopenPending(cwd, "2026-07-01T12:00:00Z");

    expect(reopenMarkerPath(cwd)).toBe(
      path.join(reviewDir(cwd), "pending-reopen.json"),
    );
    expect(await readReopenMarker(cwd)).toEqual({
      submittedAt: "2026-07-01T12:00:00Z",
      nudged: false,
    });
  });

  it("clears the marker (idempotently) on dismiss/reopen", async () => {
    const cwd = await tempRepo();
    await markReopenPending(cwd, "2026-07-01T12:00:00Z");
    await clearReopenPending(cwd);
    expect(await readReopenMarker(cwd)).toBeNull();
    // Clearing again on a missing marker must not throw.
    await expect(clearReopenPending(cwd)).resolves.toBeUndefined();
  });

  it("persists the nudged flag so a second stop is not blocked", async () => {
    const cwd = await tempRepo();
    await markReopenPending(cwd, "2026-07-01T12:00:00Z");

    const first = await readReopenMarker(cwd);
    expect(first && decideStopHook(first).block).toBe(true);
    if (first) await markReopenNudged(cwd, first);

    const second = await readReopenMarker(cwd);
    expect(second?.nudged).toBe(true);
    expect(second && decideStopHook(second).block).toBe(false);
  });

  it("does not resurrect a marker cleared before the nudge lands", async () => {
    const cwd = await tempRepo();
    await markReopenPending(cwd, "2026-07-01T12:00:00Z");
    const marker = await readReopenMarker(cwd);
    expect(marker).not.toBeNull();

    // A concurrent reopen clears the marker between read and nudge.
    await clearReopenPending(cwd);
    if (marker) await markReopenNudged(cwd, marker);

    // The nudge must be a no-op, not recreate a stale nudged marker.
    expect(await readReopenMarker(cwd)).toBeNull();
  });

  it("treats a corrupt marker file as no pending round", async () => {
    const cwd = await tempRepo();
    await markReopenPending(cwd, "2026-07-01T12:00:00Z");
    await writeFile(reopenMarkerPath(cwd), "{ not json", "utf8");
    expect(await readReopenMarker(cwd)).toBeNull();
  });
});
