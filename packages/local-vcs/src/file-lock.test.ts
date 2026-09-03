import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileLockTimeoutError,
  withFileLock,
  withFileLockSync,
} from "./file-lock";

const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createLockPath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "local-vcs-lock-"));
  testRoots.push(root);
  return path.join(root, "resource.lock");
}

function lockOptions(lockPath: string, timeoutMs = 500) {
  return {
    lockPath,
    pollMs: 20,
    staleMs: 2_000,
    timeoutMs,
    updateMs: 1_000,
  };
}

describe("file lock adapter", () => {
  it("serializes two independent processes", async () => {
    const lockPath = createLockPath();
    const root = path.dirname(lockPath);
    const logPath = path.join(root, "events.log");
    const barrierPath = path.join(root, "start");
    const workerPath = fileURLToPath(
      new URL("./test-fixtures/file-lock-worker.ts", import.meta.url),
    );
    const workers = ["a", "b"].map((actor) =>
      runWorker(workerPath, [lockPath, logPath, barrierPath, actor]),
    );

    await waitFor(() => {
      const log = readFileSync(logPath, "utf8");
      return log.includes("a:ready") && log.includes("b:ready");
    });
    writeFileSync(barrierPath, "go");
    await Promise.all(workers);

    const criticalEvents = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => !line.endsWith(":ready"));
    expect([
      ["a:start", "a:end", "b:start", "b:end"],
      ["b:start", "b:end", "a:start", "a:end"],
    ]).toContainEqual(criticalEvents);
  });

  it("refreshes a live lock heartbeat and rejects a waiter", async () => {
    const lockPath = createLockPath();
    let waiterError: unknown;
    await withFileLock(lockOptions(lockPath, 1_000), async () => {
      const acquiredMtime = statSync(lockPath).mtimeMs;
      await sleep(1_100);
      expect(statSync(lockPath).mtimeMs).toBeGreaterThan(acquiredMtime);
      try {
        await withFileLock(lockOptions(lockPath, 150), async () => undefined);
      } catch (error) {
        waiterError = error;
      }
    });

    expect(waiterError).toBeInstanceOf(FileLockTimeoutError);
    expect(existsSync(lockPath)).toBe(false);
  }, 5_000);

  it("recovers an abandoned stale lock directory", async () => {
    const lockPath = createLockPath();
    mkdirSync(lockPath);
    backdate(lockPath);

    await expect(
      withFileLock(lockOptions(lockPath), async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers a stale lock left by a killed owner process", async () => {
    const lockPath = createLockPath();
    const root = path.dirname(lockPath);
    const logPath = path.join(root, "dead-owner.log");
    const barrierPath = path.join(root, "dead-owner.start");
    const workerPath = fileURLToPath(
      new URL("./test-fixtures/file-lock-worker.ts", import.meta.url),
    );
    writeFileSync(barrierPath, "go");
    const worker = spawnWorker(workerPath, [
      lockPath,
      logPath,
      barrierPath,
      "dead",
      "10000",
    ]);
    await waitFor(() => readFileSync(logPath, "utf8").includes("dead:start"));

    worker.child.kill("SIGKILL");
    await expect(worker.completion).rejects.toThrow("SIGKILL");
    expect(existsSync(lockPath)).toBe(true);
    backdate(lockPath);

    await expect(
      withFileLock(lockOptions(lockPath), async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each(["file", "non-empty directory"])(
    "recovers a stale corrupt lock stored as a %s",
    async (kind) => {
      const lockPath = createLockPath();
      if (kind === "file") {
        writeFileSync(lockPath, "corrupt");
      } else {
        mkdirSync(lockPath);
        writeFileSync(path.join(lockPath, "unexpected"), "corrupt");
      }
      backdate(lockPath);

      await expect(
        withFileLock(lockOptions(lockPath), async () => "recovered"),
      ).resolves.toBe("recovered");
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it("times out without removing another holder's lock", async () => {
    const lockPath = createLockPath();
    mkdirSync(lockPath);

    await expect(
      withFileLock(lockOptions(lockPath, 100), async () => undefined),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("supports the synchronous lock path and releases after callback errors", () => {
    const lockPath = createLockPath();

    expect(withFileLockSync(lockOptions(lockPath), () => "sync")).toBe("sync");
    expect(existsSync(lockPath)).toBe(false);
    expect(() =>
      withFileLockSync(lockOptions(lockPath), () => {
        throw new Error("callback failed");
      }),
    ).toThrow("callback failed");
    expect(existsSync(lockPath)).toBe(false);
  });
});

function backdate(targetPath: string): void {
  const old = new Date(Date.now() - 10_000);
  utimesSync(targetPath, old, old);
}

async function runWorker(workerPath: string, args: string[]): Promise<void> {
  return await spawnWorker(workerPath, args).completion;
}

function spawnWorker(workerPath: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, ...args],
    {
      cwd: path.resolve(fileURLToPath(new URL("../../..", import.meta.url))),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else
        rejectExit(
          new Error(
            `Lock worker failed (${signal ?? code ?? "unknown"}): ${stderr}`,
          ),
        );
    });
  });
  return { child, completion };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // The workers have not created the shared log yet.
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for lock workers.");
}
