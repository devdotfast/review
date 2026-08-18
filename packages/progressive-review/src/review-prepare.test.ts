import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareReviewPinnedCheckout,
  reviewPrepareLogPath,
  reviewPrepareMarkerPath,
} from "./review-prepare";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("prepareReviewPinnedCheckout", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => rm(target, { recursive: true, force: true })),
    );
  });

  async function createCheckoutDir(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-prepare-"));
    cleanupPaths.push(root);
    const checkoutPath = path.join(root, "worktree");
    await mkdir(checkoutPath, { recursive: true });
    return checkoutPath;
  }

  it("runs the commands in order with the checkout as the cwd", async () => {
    const checkoutPath = await createCheckoutDir();
    const runs: Array<{ command: string; cwd: string }> = [];

    const result = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["pnpm install", "uv sync"],
      runCommand: async (command, cwd) => {
        runs.push({ command, cwd });
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ prepared: true });
    expect(runs).toEqual([
      { command: "pnpm install", cwd: checkoutPath },
      { command: "uv sync", cwd: checkoutPath },
    ]);
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(true);
  });

  it("skips a checkout whose marker matches the command list", async () => {
    const checkoutPath = await createCheckoutDir();
    const commands = ["pnpm install"];
    let runCount = 0;
    const runCommand = async () => {
      runCount += 1;
      return { exitCode: 0 };
    };

    await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands,
      runCommand,
    });
    const second = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands,
      runCommand,
    });

    expect(second).toEqual({ prepared: true });
    expect(runCount).toBe(1);
  });

  it("re-runs prepare when the configured command list changes", async () => {
    const checkoutPath = await createCheckoutDir();
    const runs: string[] = [];
    const runCommand = async (command: string) => {
      runs.push(command);
      return { exitCode: 0 };
    };

    await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["pnpm install"],
      runCommand,
    });
    await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["pnpm install", "uv sync"],
      runCommand,
    });

    expect(runs).toEqual(["pnpm install", "pnpm install", "uv sync"]);
  });

  it("warns with the commit and command on failure and leaves no marker", async () => {
    const checkoutPath = await createCheckoutDir();
    const warnings: string[] = [];
    const runs: string[] = [];

    const result = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["pnpm install", "uv sync"],
      warning: (message) => warnings.push(message),
      runCommand: async (command) => {
        runs.push(command);
        return { exitCode: command === "pnpm install" ? 42 : 0 };
      },
    });

    expect(result).toEqual({ prepared: false });
    // The failing first command stops the sequence.
    expect(runs).toEqual(["pnpm install"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(COMMIT.slice(0, 12));
    expect(warnings[0]).toContain("pnpm install");
    expect(warnings[0]).toContain("exit 42");
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(false);
  });

  it("retries after a failure and removes a stale marker before re-running", async () => {
    const checkoutPath = await createCheckoutDir();
    // First configuration succeeds and writes the marker.
    await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["pnpm install"],
      runCommand: async () => ({ exitCode: 0 }),
    });

    // A changed configuration that fails must not leave the old marker.
    const failed = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["uv sync"],
      runCommand: async () => ({ exitCode: 1 }),
    });
    expect(failed).toEqual({ prepared: false });
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(false);

    // The next attempt runs again and succeeds.
    const retried = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["uv sync"],
      runCommand: async () => ({ exitCode: 0 }),
    });
    expect(retried).toEqual({ prepared: true });
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(true);
  });

  it("does nothing when no commands are configured", async () => {
    const checkoutPath = await createCheckoutDir();

    const result = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: [],
      runCommand: async () => {
        throw new Error("must not run");
      },
    });

    expect(result).toEqual({ prepared: false });
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(false);
  });

  it("runs real shell commands with the checkout as the cwd", async () => {
    const checkoutPath = await createCheckoutDir();

    const result = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["printf prepared > prepare-output.txt"],
    });

    expect(result).toEqual({ prepared: true });
    expect(existsSync(path.join(checkoutPath, "prepare-output.txt"))).toBe(
      true,
    );
  });

  it("includes the output tail in the failure warning and writes the log", async () => {
    const checkoutPath = await createCheckoutDir();
    const warnings: string[] = [];

    const result = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["echo lockfile mismatch >&2; exit 7"],
      warning: (message) => warnings.push(message),
    });

    expect(result).toEqual({ prepared: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exit 7");
    expect(warnings[0]).toContain("lockfile mismatch");
    const logPath = reviewPrepareLogPath(checkoutPath);
    expect(warnings[0]).toContain(logPath);
    expect(readFileSync(logPath, "utf8")).toContain("lockfile mismatch");
    expect(existsSync(reviewPrepareMarkerPath(checkoutPath))).toBe(false);
  });

  it("removes a previous failure log once prepare succeeds", async () => {
    const checkoutPath = await createCheckoutDir();

    await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["echo bad >&2; exit 1"],
    });
    expect(existsSync(reviewPrepareLogPath(checkoutPath))).toBe(true);

    const retried = await prepareReviewPinnedCheckout({
      checkoutPath,
      commit: COMMIT,
      commands: ["true"],
    });

    expect(retried).toEqual({ prepared: true });
    expect(existsSync(reviewPrepareLogPath(checkoutPath))).toBe(false);
  });
});
