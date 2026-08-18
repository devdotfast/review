import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runReviewTraceHook } from "./trace-hook-runner";
import { configureTraceMachine } from "./trace-machine-setup";

const execFilePromise = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
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

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trace-hook-runner-test-"));
  tempRoots.push(dir);
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(dir, "README.md"), "# Test\n");
  await runGit(dir, ["add", "README.md"]);
  await runGit(dir, ["commit", "-m", "initial"]);
  await configureTraceMachine({
    homeDir: dir,
    env: { TRACE_R2_MODE: "mock" },
    credentials: {
      endpoint: "mock://endpoint",
      bucket: "mock-bucket",
      key: "mock-key",
      secret: "mock-secret",
    },
  });
  return dir;
}

describe("runReviewTraceHook", () => {
  it("records session ID on SessionStart and removes on SessionEnd", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";

    // 1. SessionStart via CLI args
    const startCode = await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });
    expect(startCode).toBe(0);

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(true);
    expect(await readFile(agentSessionFile, "utf8")).toBe(`${sessionId}\n`);

    // 2. Another session joins
    const secondSessionId = "02b015e4-0477-7055-a0fd-21a0f72a4ec7";
    await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: secondSessionId,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${sessionId}\n${secondSessionId}\n`,
    );

    // 3. First session ends
    const endCode = await runReviewTraceHook({
      cwd: repo,
      event: "SessionEnd",
      sessionId,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });
    expect(endCode).toBe(0);
    expect(await readFile(agentSessionFile, "utf8")).toBe(
      `${secondSessionId}\n`,
    );

    // 4. Second session ends (file should be deleted)
    await runReviewTraceHook({
      cwd: repo,
      event: "SessionEnd",
      sessionId: secondSessionId,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });
    expect(existsSync(agentSessionFile)).toBe(false);
  });

  it("parses Claude/Codex hook JSON from stdin", async () => {
    const repo = await makeGitRepo();
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";

    const startPayload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
    });
    const stdinStart = Readable.from([
      startPayload,
    ]) as unknown as NodeJS.ReadStream;

    await runReviewTraceHook({
      cwd: repo,
      event: "unknown",
      stdin: stdinStart,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(true);
    expect(await readFile(agentSessionFile, "utf8")).toBe(`${sessionId}\n`);

    const endPayload = JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
    });
    const stdinEnd = Readable.from([
      endPayload,
    ]) as unknown as NodeJS.ReadStream;

    await runReviewTraceHook({
      cwd: repo,
      event: "unknown",
      stdin: stdinEnd,
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });

    expect(existsSync(agentSessionFile)).toBe(false);
  });

  it("writes valid Jujutsu commit trailer templates", async () => {
    if (!(await commandAvailable("jj"))) return;
    const repo = await makeGitRepo();
    await runJj(repo, ["git", "init", "--colocate", "."]);
    const firstSessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";
    const secondSessionId = "02b015e4-0477-7055-a0fd-21a0f72a4ec7";

    for (const sessionId of [firstSessionId, secondSessionId]) {
      await runReviewTraceHook({
        cwd: repo,
        event: "SessionStart",
        sessionId,
        homeDir: repo,
        env: { TRACE_R2_MODE: "mock" },
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
  });

  it("ignores invalid or malformed session IDs safely", async () => {
    const repo = await makeGitRepo();

    const code = await runReviewTraceHook({
      cwd: repo,
      event: "SessionStart",
      sessionId: "invalid!@#$%",
      homeDir: repo,
      env: { TRACE_R2_MODE: "mock" },
    });
    expect(code).toBe(0);

    const agentSessionFile = path.join(repo, ".git", "agent-session");
    expect(existsSync(agentSessionFile)).toBe(false);
  });
});

async function commandAvailable(command: string): Promise<boolean> {
  return execFilePromise(command, ["--version"])
    .then(() => true)
    .catch(() => false);
}
