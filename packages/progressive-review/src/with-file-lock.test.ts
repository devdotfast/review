import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "./with-file-lock";

const FAST = {
  retryMs: 10,
  staleMs: 60_000,
  timeoutMs: 250,
  unownedGraceMs: 50,
};

describe("withFileLock", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  async function createLockPath(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "with-file-lock-"));
    cleanupPaths.push(root);
    return path.join(root, "resource.lock");
  }

  it("acquires, runs the operation, and releases", async () => {
    const lockPath = await createLockPath();

    const outcome = await withFileLock(lockPath, FAST, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return "ran";
    });

    expect(outcome).toEqual({ acquired: true, result: "ran" });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("steals a lock whose owning process is dead", async () => {
    const lockPath = await createLockPath();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647 }),
      "utf8",
    );

    const outcome = await withFileLock(lockPath, FAST, async () => "ran");

    expect(outcome).toEqual({ acquired: true, result: "ran" });
  });

  it("never steals from a live owner inside the stale window", async () => {
    const lockPath = await createLockPath();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    // Older than the old age-based theft would tolerate, but the owner is
    // alive and the heartbeat window has not passed: the waiter must time
    // out instead of stealing.
    const aged = new Date(Date.now() - 10_000);
    await utimes(lockPath, aged, aged);

    const outcome = await withFileLock(lockPath, FAST, async () => "ran");

    expect(outcome).toEqual({ acquired: false });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reclaims a live owner only after the heartbeat goes silent past staleMs", async () => {
    const lockPath = await createLockPath();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    const silent = new Date(Date.now() - 5_000);
    await utimes(lockPath, silent, silent);

    const outcome = await withFileLock(
      lockPath,
      { ...FAST, staleMs: 1_000 },
      async () => "ran",
    );

    expect(outcome).toEqual({ acquired: true, result: "ran" });
  });

  it("reclaims a lock whose owner file never appeared after the grace", async () => {
    const lockPath = await createLockPath();
    await mkdir(lockPath, { recursive: true });
    const aged = new Date(Date.now() - 1_000);
    await utimes(lockPath, aged, aged);

    const outcome = await withFileLock(lockPath, FAST, async () => "ran");

    expect(outcome).toEqual({ acquired: true, result: "ran" });
  });

  it("does not release a lock that was reclaimed while the holder was still live", async () => {
    const lockPath = await createLockPath();
    // Reproduces the suspended-holder reclaim: the original holder acquires,
    // its heartbeat then goes silent past staleMs (simulated by backdating the
    // lock mtime, the symptom of a frozen event loop from laptop sleep /
    // SIGSTOP / container freeze), a waiter reclaims, and the original holder
    // later resumes. The original holder's `finally` must not rm the directory
    // the reclaimer now owns.
    //
    // Both holders run in this process, so their owner.json pids are
    // identical; ownership must be tracked by a per-acquisition token, not by
    // pid alone.
    //
    // The handshakes below make the interleaving DETERMINISTIC (the two
    // withFileLock calls race to mkdir on the fs thread pool, so without a
    // gate the roles can invert): the reclaimer does not even call
    // withFileLock until the original holder has acquired AND backdated the
    // mtime, so the reclaimer is guaranteed to be the one that contends and
    // reclaims. The reclaimer then awaits the original holder's full
    // withFileLock promise — which resolves only once the original holder's
    // `finally` has run — before asserting, so the assertion never depends on
    // a fixed sleep.
    const opts = {
      retryMs: 5,
      staleMs: 50,
      timeoutMs: 10_000,
      unownedGraceMs: 10_000,
      heartbeatMs: 60_000,
    };

    let originalHolding!: () => void;
    const originalHoldingP = new Promise<void>(
      (resolve) => (originalHolding = resolve),
    );
    let reclaimerAcquired!: () => void;
    const reclaimerStarted = new Promise<void>(
      (resolve) => (reclaimerAcquired = resolve),
    );

    const original = withFileLock(lockPath, opts, async () => {
      // Simulate the suspended-process symptom: the heartbeat mtime is older
      // than staleMs, so a waiter reclaims. This runs only after the original
      // holder has already acquired, and it signals `originalHolding` only
      // after the backdate, so the reclaimer is certain to observe a stale
      // lock on its first contend.
      const stale = new Date(Date.now() - 1_000);
      await utimes(lockPath, stale, stale);
      originalHolding();
      await reclaimerStarted;
      return "original";
    });

    // Do not start the reclaimer until the original holder is holding and its
    // mtime is already stale; this fixes which side acquires first.
    await originalHoldingP;

    const reclaimer = withFileLock(lockPath, opts, async () => {
      reclaimerAcquired();
      // Waiting for the original holder's full promise guarantees its `finally`
      // (which must choose to skip the rm) has executed before we inspect the
      // lock directory.
      await original;
      expect(existsSync(lockPath)).toBe(true);
      const owner = JSON.parse(
        await readFile(path.join(lockPath, "owner.json"), "utf8"),
      );
      expect(owner.pid).toBe(process.pid);
      return "reclaimer";
    });

    const outcomes = await Promise.all([original, reclaimer]);
    expect(outcomes).toEqual([
      { acquired: true, result: "original" },
      { acquired: true, result: "reclaimer" },
    ]);
    // The rightful owner (the reclaimer) still releases its own lock, so the
    // original holder skipping rm does not leak the directory.
    expect(existsSync(lockPath)).toBe(false);
  });
});
