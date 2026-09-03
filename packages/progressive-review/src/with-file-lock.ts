import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  jsonNumber,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

const LOCK_OWNER_FILE = "owner.json";
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface FileLockOptions {
  retryMs: number;
  /** Reclaim after this long without a heartbeat touch (see policy below). */
  staleMs: number;
  timeoutMs: number;
  /** Reclaim a lock whose owner.json never appeared after this long. */
  unownedGraceMs: number;
  /** How often the holder refreshes the lock mtime. */
  heartbeatMs?: number;
}

export type FileLockOutcome<T> =
  | { acquired: true; result: T }
  | { acquired: false };

// The one cross-process mutex idiom for this package (checkout, prepare,
// graph build): a lock DIRECTORY taken with atomic mkdir, an owner.json pid
// inside, and a heartbeat that touches the lock mtime while the holder works.
//
// Reclaim policy: a waiter steals the lock only when the owner is provably
// dead (pid signal fails), when owner.json never appeared within the unowned
// grace (a crash between mkdir and write), or when the heartbeat has been
// silent past staleMs. The last clause is a deliberate judgment call:
// heartbeat-stopped is treated as dead. An owner that heartbeats is never
// stolen from, no matter how long its work runs; only a process whose event
// loop is starved for the whole stale window (minutes) can be falsely
// reclaimed, and that trade is accepted so a hung holder cannot wedge every
// future review.
export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  operation: () => Promise<T>,
): Promise<FileLockOutcome<T>> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          path.join(lockPath, LOCK_OWNER_FILE),
          JSON.stringify({ pid: process.pid }),
          "utf8",
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockAge = await stat(lockPath)
        .then((metadata) => Date.now() - metadata.mtimeMs)
        .catch(() => 0);
      const ownerPid = await readLockOwner(lockPath);
      const ownerDead = ownerPid !== null && !processIsAlive(ownerPid);
      const neverOwned = ownerPid === null && lockAge > options.unownedGraceMs;
      const heartbeatSilent = lockAge > options.staleMs;
      if (ownerDead || neverOwned || heartbeatSilent) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return { acquired: false };
      await delay(options.retryMs);
    }
  }
  const heartbeat = startHeartbeat(
    lockPath,
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  );
  try {
    return { acquired: true, result: await operation() };
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function startHeartbeat(lockPath: string, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {
      // The lock may already be reclaimed; the next steal check settles it.
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function readLockOwner(lockPath: string): Promise<number | null> {
  return readFile(path.join(lockPath, LOCK_OWNER_FILE), "utf8")
    .then(
      (contents) =>
        jsonNumber(jsonObject(parseJsonText(contents))?.pid) ?? null,
    )
    .catch(() => null);
}
