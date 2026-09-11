import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import * as hookRunner from "./trace-hook-runner";
import { traceConfigPath } from "./trace-storage/config";
import { allowTraceRepository } from "./trace-user-config";

const execFilePromise = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("runReviewTraceGitHook", () => {
  let repo: string;
  let devHome: string;
  let stderrText: string;
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrText += String(chunk);
      callback();
    },
  });

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "trace-git-hook-"));
    devHome = path.join(repo, ".dev");
    stderrText = "";
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("HOME", repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.test"]);
    await git(repo, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
    await writeFile(path.join(repo, "README.md"), "# T\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, [
      "commit",
      "-m",
      "initial\n\nAgent-Session: 01a015e4-0477-7055-a0fd-21a0f72a4ec9",
    ]);
    clearTraceEnvCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearTraceEnvCache();
    await rm(repo, { recursive: true, force: true });
  });

  async function selectHosted(): Promise<void> {
    const filePath = traceConfigPath({ devHome });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, "current-store": "hosted" }),
    );
    await allowTraceRepository(
      { repositoryId: 1, name: "acme/app", origin: "https://app.dev.fast" },
      devHome,
    );
    clearTraceEnvCache();
  }

  function prePush(): Promise<number> {
    return git(repo, ["rev-parse", "HEAD"]).then((sha) =>
      runReviewTraceGitHook({
        cwd: repo,
        hook: "pre-push",
        args: ["origin", "git@github.com:acme/app.git"],
        stdin: Readable.from([
          `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        ]),
        stderr,
      }),
    );
  }

  it("does nothing while the machine switch is off", async () => {
    const spawned = vi.spyOn(hookRunner, "spawnDetachedTraceSync");
    expect(await prePush()).toBe(0);
    expect(spawned).not.toHaveBeenCalled();
    expect(stderrText).toBe("");
  });

  it("detaches the hosted publish instead of uploading inside the push", async () => {
    await selectHosted();
    const spawned = vi
      .spyOn(hookRunner, "spawnDetachedTraceSync")
      .mockImplementation(() => undefined);
    expect(await prePush()).toBe(0);
    expect(spawned).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "01a015e4-0477-7055-a0fd-21a0f72a4ec9",
        cwd: repo,
      }),
    );
  });
});
