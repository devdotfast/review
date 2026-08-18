import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import properLockfile from "proper-lockfile";

export class FileLockTimeoutError extends Error {
  constructor(lockPath, waitedMs) {
    super(`Timed out after ${waitedMs}ms waiting for lock ${lockPath}.`);
    this.name = "FileLockTimeoutError";
  }
}

export async function withFileLock(input, callback) {
  const options = normalizeOptions(input);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;

  while (true) {
    await repairStaleMalformedLock(options.lockPath, options.staleMs);
    let compromisedError = null;
    let release;
    try {
      release = await properLockfile.lock(options.lockPath, {
        lockfilePath: options.lockPath,
        onCompromised: (error) => {
          compromisedError = error;
        },
        realpath: false,
        retries: 0,
        stale: options.staleMs,
        update: options.updateMs,
      });
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      if (Date.now() >= deadline) {
        throw options.createTimeoutError
          ? options.createTimeoutError(options.lockPath, Date.now() - startedAt)
          : new FileLockTimeoutError(options.lockPath, Date.now() - startedAt);
      }
      await sleep(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    return await runLockedCallback(callback, release, () => compromisedError);
  }
}

async function runLockedCallback(callback, release, compromisedError) {
  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }

  let releaseError;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }

  if (callbackError !== undefined) throw callbackError;
  if (compromisedError()) throw compromisedError();
  if (releaseError !== undefined) throw releaseError;
  return result;
}

function normalizeOptions(options) {
  const lockPath = path.resolve(options.lockPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleMs = Math.max(2_000, options.staleMs);
  return {
    ...options,
    lockPath,
    pollMs: Math.max(1, options.pollMs),
    staleMs,
    timeoutMs: Math.max(0, options.timeoutMs),
    updateMs: Math.max(
      1_000,
      Math.min(options.updateMs ?? staleMs / 2, staleMs / 2),
    ),
  };
}

async function repairStaleMalformedLock(lockPath, staleMs) {
  const first = await fs.promises.lstat(lockPath).catch(() => null);
  if (!first || !(await isMalformedLock(lockPath, first))) return;
  if (Date.now() - first.mtimeMs <= staleMs) return;

  const confirmed = await fs.promises.lstat(lockPath).catch(() => null);
  if (!confirmed || confirmed.mtimeMs !== first.mtimeMs) return;
  await fs.promises.rm(lockPath, { force: true, recursive: true });
}

async function isMalformedLock(lockPath, stats) {
  if (!stats.isDirectory()) return true;
  const entries = await fs.promises.readdir(lockPath).catch(() => []);
  return entries.length > 0;
}

function isLockContentionError(error) {
  return ["EEXIST", "ELOCKED", "ENOTDIR", "ENOTEMPTY"].includes(error?.code);
}
