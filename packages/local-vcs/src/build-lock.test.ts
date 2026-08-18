import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workerPath = path.join(
  packageRoot,
  "src/test-fixtures/build-lock-worker.mjs",
);
const temporaryRoots: string[] = [];

describe("local-vcs build lock", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("serializes concurrent builds across processes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-vcs-build-lock-"));
    temporaryRoots.push(root);
    const lockPath = path.join(root, "build.lock");
    const logPath = path.join(root, "events.log");
    const barrierPath = path.join(root, "start");
    const workers = ["a", "b"].map((actor) =>
      runWorker([lockPath, logPath, barrierPath, actor]),
    );

    await waitFor(() => {
      const log = readFileSync(logPath, "utf8");
      return log.includes("a:ready") && log.includes("b:ready");
    });
    writeFileSync(barrierPath, "go");
    await Promise.all(workers);

    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => !line.endsWith(":ready"));
    expect(
      [
        ["a:start", "a:end", "b:start", "b:end"],
        ["b:start", "b:end", "a:start", "a:end"],
      ].some((expected) => JSON.stringify(expected) === JSON.stringify(events)),
    ).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

async function runWorker(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveExit();
        return;
      }
      rejectExit(
        new Error(
          `Build-lock worker failed (${signal ?? code ?? "unknown"}): ${stderr}`,
        ),
      );
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // Workers have not created their shared log yet.
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for local-vcs build-lock workers.");
}
