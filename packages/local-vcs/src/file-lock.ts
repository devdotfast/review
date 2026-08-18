import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import properLockfile from "proper-lockfile";

export interface FileLockOptions {
  lockPath: string;
  staleMs: number;
  updateMs?: number;
  timeoutMs: number;
  pollMs: number;
  createTimeoutError?: (lockPath: string, waitedMs: number) => Error;
}

interface AcquiredLock {
  compromisedError: () => Error | null;
  release: () => Promise<void>;
}

interface AcquiredLockSync {
  compromisedError: () => Error | null;
  release: () => void;
}

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(`Timed out after ${waitedMs}ms waiting for lock ${lockPath}.`);
    this.name = "FileLockTimeoutError";
  }
}

export async function withFileLock<T>(
  options: FileLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const acquired = await acquireFileLock(options);
  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }

  let releaseError: unknown;
  try {
    await acquired.release();
  } catch (error) {
    releaseError = error;
  }

  if (callbackError !== undefined) throw callbackError;
  const compromisedError = acquired.compromisedError();
  if (compromisedError) throw compromisedError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

export function withFileLockSync<T>(
  options: FileLockOptions,
  callback: () => T,
): T {
  const acquired = acquireFileLockSync(options);
  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = callback();
  } catch (error) {
    callbackError = error;
  }

  let releaseError: unknown;
  try {
    acquired.release();
  } catch (error) {
    releaseError = error;
  }

  if (callbackError !== undefined) throw callbackError;
  const compromisedError = acquired.compromisedError();
  if (compromisedError) throw compromisedError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

async function acquireFileLock(input: FileLockOptions): Promise<AcquiredLock> {
  const options = normalizeOptions(input);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;

  while (true) {
    await repairStaleMalformedLock(options.lockPath, options.staleMs);
    let compromisedError: Error | null = null;
    try {
      const release = await properLockfile.lock(options.lockPath, {
        lockfilePath: options.lockPath,
        onCompromised: (error) => {
          compromisedError = error;
        },
        realpath: false,
        retries: 0,
        stale: options.staleMs,
        update: options.updateMs,
      });
      return {
        compromisedError: () => compromisedError,
        release,
      };
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      if (Date.now() >= deadline) {
        throw createTimeoutError(options, Date.now() - startedAt);
      }
      await sleep(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function acquireFileLockSync(input: FileLockOptions): AcquiredLockSync {
  const options = normalizeOptions(input);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;

  while (true) {
    repairStaleMalformedLockSync(options.lockPath, options.staleMs);
    let compromisedError: Error | null = null;
    try {
      const release = properLockfile.lockSync(options.lockPath, {
        lockfilePath: options.lockPath,
        onCompromised: (error) => {
          compromisedError = error;
        },
        realpath: false,
        retries: 0,
        stale: options.staleMs,
        update: options.updateMs,
      });
      return {
        compromisedError: () => compromisedError,
        release,
      };
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      if (Date.now() >= deadline) {
        throw createTimeoutError(options, Date.now() - startedAt);
      }
      waitSync(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function normalizeOptions(
  options: FileLockOptions,
): Required<Omit<FileLockOptions, "createTimeoutError">> &
  Pick<FileLockOptions, "createTimeoutError"> {
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

function createTimeoutError(options: FileLockOptions, waitedMs: number): Error {
  return options.createTimeoutError
    ? options.createTimeoutError(options.lockPath, waitedMs)
    : new FileLockTimeoutError(options.lockPath, waitedMs);
}

async function repairStaleMalformedLock(
  lockPath: string,
  staleMs: number,
): Promise<void> {
  const first = await fs.promises.lstat(lockPath).catch(() => null);
  if (!first || !(await isMalformedLock(lockPath, first))) return;
  if (Date.now() - first.mtimeMs <= staleMs) return;

  const confirmed = await fs.promises.lstat(lockPath).catch(() => null);
  if (!confirmed || confirmed.mtimeMs !== first.mtimeMs) return;
  await fs.promises.rm(lockPath, { force: true, recursive: true });
}

function repairStaleMalformedLockSync(lockPath: string, staleMs: number): void {
  const first = lstatSyncOrNull(lockPath);
  if (!first || !isMalformedLockSync(lockPath, first)) return;
  if (Date.now() - first.mtimeMs <= staleMs) return;

  const confirmed = lstatSyncOrNull(lockPath);
  if (!confirmed || confirmed.mtimeMs !== first.mtimeMs) return;
  fs.rmSync(lockPath, { force: true, recursive: true });
}

async function isMalformedLock(
  lockPath: string,
  stats: fs.Stats,
): Promise<boolean> {
  if (!stats.isDirectory()) return true;
  const entries = await fs.promises.readdir(lockPath).catch(() => []);
  return entries.length > 0;
}

function isMalformedLockSync(lockPath: string, stats: fs.Stats): boolean {
  if (!stats.isDirectory()) return true;
  try {
    return fs.readdirSync(lockPath).length > 0;
  } catch {
    return false;
  }
}

function lstatSyncOrNull(lockPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(lockPath);
  } catch {
    return null;
  }
}

function isLockContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === "EEXIST" ||
    code === "ELOCKED" ||
    code === "ENOTDIR" ||
    code === "ENOTEMPTY"
  );
}

function waitSync(durationMs: number): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, durationMs);
}
