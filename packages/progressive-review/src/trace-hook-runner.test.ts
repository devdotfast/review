import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRACE_SESSION_TTL_MS,
  readActiveTraceSessions,
} from "./trace-agent-sessions";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import { runReviewTraceHook } from "./trace-hook-runner";
import { allowTraceRepository } from "./trace-user-config";

const execFilePromise = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function runJj(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("jj", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout;
}

/**
 * A Git repository with a GitHub remote. By default the repo is also
 * allowed to publish traces, matching most tests below; pass `allow: false`
 * to leave it un-allowed.
 */
async function makeGitRepo(
  options: { remote?: string; allow?: boolean } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trace-hook-runner-test-"));
  tempRoots.push(dir);
  const remote = options.remote ?? "git@github.com:acme/hook-test.git";
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["remote", "add", "origin", remote]);
  await writeFile(path.join(dir, "README.md"), "# Test\n");
  await runGit(dir, ["add", "README.md"]);
  await runGit(dir, ["commit", "-m", "initial"]);
  if (options.allow !== false) {
    const match = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (!match) throw new Error(`Could not parse test remote: ${remote}`);
    await allowTraceRepository(
      {
        repositoryId: 1,
        name: `${match[1]}/${match[2]}`,
        store: "https://app.dev.fast",
      },
      dir,
    );
  }
  return dir;
}

describe("runReviewTraceHook", () => {
  it("records session ID on SessionStart and removes on SessionEnd", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    // 1. SessionStart via CLI args
    const startCode = await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(startCode).toBe(0);

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(true);
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${sessionId}\t${now}\n`,
    );

    // 2. Another session joins
    const secondSessionId = "02b015e4-0477-7055-a0fd-21a0f72a4ec7";
    await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: secondSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${sessionId}\t${now}\n${secondSessionId}\t${now}\n`,
    );

    // 3. First session ends
    const endCode = await runReviewTraceHook({
      cwd: repo,
      event: "SessionEnd",
      sessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(endCode).toBe(0);
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${secondSessionId}\t${now}\n`,
    );

    // 4. Second session ends (file should be deleted)
    await runReviewTraceHook({
      cwd: repo,
      event: "SessionEnd",
      sessionId: secondSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(existsSync(agentSessionFile)).toBe(false);
  });

  it("parses Claude/Codex hook JSON from stdin", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const startPayload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
    });
    const stdinStart = Readable.from([startPayload]);

    await runReviewTraceHook({
      cwd: repo,
      event: "unknown",
      stdin: stdinStart,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(true);
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${sessionId}\t${now}\n`,
    );

    const endPayload = JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
    });
    const stdinEnd = Readable.from([endPayload]);

    await runReviewTraceHook({
      cwd: repo,
      event: "unknown",
      stdin: stdinEnd,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });

    expect(existsSync(agentSessionFile)).toBe(false);
  });

  it("refreshes timestamps on turn start and drops stale sessions", async () => {
    const repo = await makeGitRepo();
    const staleSessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const activeSessionId = "02b015e4-0477-7055-a0fd-21a0f72a4ec7";
    const startedAt = 1_800_000_000_000;
    const heartbeatAt = startedAt + TRACE_SESSION_TTL_MS + 1;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);

    await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: staleSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    now.mockReturnValue(heartbeatAt);
    await runReviewTraceHook({
      cwd: repo,
      event: "UserPromptSubmit",
      sessionId: activeSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${activeSessionId}\t${heartbeatAt}\n`,
    );

    now.mockReturnValue(heartbeatAt + 1_000);
    await runReviewTraceHook({
      cwd: repo,
      event: "turn_start",
      sessionId: activeSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${activeSessionId}\t${heartbeatAt + 1_000}\n`,
    );
  });

  it("prunes stale sessions before stamping a Git commit", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const startedAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);

    await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    now.mockReturnValue(startedAt + TRACE_SESSION_TTL_MS + 1);
    const messagePath = path.join(repo, ".git", "COMMIT_EDITMSG");
    await writeFile(messagePath, "Test commit\n");
    await runReviewTraceGitHook({
      cwd: repo,
      hook: "prepare-commit-msg",
      args: [messagePath],
      stderr: process.stderr,
    });

    expect(await readFile(messagePath, "utf8")).toBe("Test commit\n");
    expect(existsSync(path.join(repo, ".git", "agent-session"))).toBe(false);

    await runReviewTraceHook({
      cwd: repo,
      event: "UserPromptSubmit",
      sessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    await writeFile(messagePath, "Fresh commit\n");
    await runReviewTraceGitHook({
      cwd: repo,
      hook: "prepare-commit-msg",
      args: [messagePath],
      stderr: process.stderr,
    });
    expect(await readFile(messagePath, "utf8")).toContain(
      `Agent-Session: ${sessionId}`,
    );
  });

  it("writes valid Jujutsu commit trailer templates", async () => {
    if (!(await commandAvailable("jj"))) return;
    const repo = await makeGitRepo();
    await runJj(repo, ["git", "init", "--colocate", "."]);
    const firstSessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const secondSessionId = "02b015e4-0477-7055-a0fd-21a0f72a4ec7";
    const startedAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);

    for (const sessionId of [firstSessionId, secondSessionId]) {
      await runReviewTraceHook({
        cwd: repo,
        event: "SessionStart",
        sessionId,
        homeDir: repo,
        env: { DEV_REVIEW_HOME: repo },
      });
    }

    await runJj(repo, ["describe", "-m", "Trace work"]);
    const description = await runJj(repo, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "description",
    ]);
    expect(description).toBe(
      `Trace work\n\nAgent-Session: ${firstSessionId}\nAgent-Session: ${secondSessionId}\n`,
    );

    now.mockReturnValue(startedAt + TRACE_SESSION_TTL_MS + 1);
    await runReviewTraceHook({
      cwd: repo,
      event: "UserPromptSubmit",
      sessionId: firstSessionId,
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    await runJj(repo, ["describe", "-m", "Fresh trace work"]);
    const refreshedDescription = await runJj(repo, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "description",
    ]);
    expect(refreshedDescription).toBe(
      `Fresh trace work\n\nAgent-Session: ${firstSessionId}\n`,
    );
  });

  it("ignores invalid or malformed session IDs safely", async () => {
    const repo = await makeGitRepo();

    const code = await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: "invalid!@#$%",
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(code).toBe(0);

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(false);
  });

  it("ignores a repository with no allow entry", async () => {
    const repo = await makeGitRepo({
      remote: "git@github.com:acme/other.git",
      allow: false,
    });

    const code = await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: "01a015e4-0477-7055-a0fd-21a0f72a4ec9",
      homeDir: repo,
      env: { DEV_REVIEW_HOME: repo },
    });
    expect(code).toBe(0);

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(await readActiveTraceSessions(agentSessionFile)).toEqual(new Map());
  });

  it("swallows an unresolvable SessionEnd sync command without crashing the hook", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const missingBinary = path.join(
      os.tmpdir(),
      "definitely-missing-review-binary",
    );
    const prior = process.env.REVIEW_TRACE_COMMAND;
    let uncaught: Error | null = null;
    const onUncaught = (err: Error) => {
      uncaught = err;
    };
    process.on("uncaughtException", onUncaught);
    try {
      process.env.REVIEW_TRACE_COMMAND = missingBinary;
      const code = await runReviewTraceHook({
        cwd: repo,
        event: "SessionEnd",
        sessionId,
        homeDir: repo,
        env: { DEV_REVIEW_HOME: repo },
      });
      // Drain queued ticks so an async spawn `error` (if unhandled) would fire.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(code).toBe(0);
      expect(uncaught).toBe(null);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      if (prior === undefined) delete process.env.REVIEW_TRACE_COMMAND;
      else process.env.REVIEW_TRACE_COMMAND = prior;
    }
  });
});

async function commandAvailable(command: string): Promise<boolean> {
  return execFilePromise(command, ["--version"])
    .then(() => true)
    .catch(() => false);
}
