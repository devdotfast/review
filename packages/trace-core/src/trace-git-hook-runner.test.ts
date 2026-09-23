import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { traceScope } from "./trace-command";
import { allowTraceRepository } from "./trace-consent";
import { runTraceGitHook } from "./trace-git-hook-runner";
import * as hookRunner from "./trace-hook-runner";
import { traceSettingsPath } from "./trace-machine-setup";
import { traceConfigPath } from "./trace-storage/config";

const execFilePromise = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });

  return stdout.trim();
}

describe("runTraceGitHook", () => {
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
    vi.stubEnv("DEV_WHITEBOARD_HOME", devHome);
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

  function prePush(traceCommand?: { file: string }): Promise<number> {
    return git(repo, ["rev-parse", "HEAD"]).then((sha) =>
      runTraceGitHook({
        cwd: repo,
        hook: "pre-push",
        args: ["origin", "git@github.com:acme/app.git"],
        stdin: Readable.from([
          `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        ]),
        stderr,
        scope: traceScope({ homeDir: repo, env: process.env }),
        traceCommand,
      }),
    );
  }

  it("does nothing while the machine switch is off", async () => {
    const spawned = vi.spyOn(hookRunner, "spawnDetachedTraceSync");
    expect(await prePush()).toBe(0);
    expect(spawned).not.toHaveBeenCalled();
    expect(stderrText).toBe("");
  });

  it("uploads a local transcript to the direct store and preserves links for nonlocal sessions", async () => {
    const bucket = path.join(repo, "bucket");
    vi.stubEnv("TRACE_R2_MODE", "mock");
    vi.stubEnv("TRACE_R2_MOCK_DIR", bucket);
    const settings = traceSettingsPath(repo, process.env);
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify({
        version: 1,
        enabled: true,
        autoActivateRepositories: true,
      }),
    );
    const sessionsRoot = path.join(repo, "local-traces");
    await mkdir(sessionsRoot);
    vi.stubEnv("TRACE_LOCAL_TRACE_ROOT", sessionsRoot);
    const sessionId = "01a015e4-0477-7055-a0fd-21a0f72a4ec9";

    const transcript =
      '{"type":"user","message":{"content":"Preserve direct storage"}}\n';

    await writeFile(path.join(sessionsRoot, `${sessionId}.jsonl`), transcript);
    const remoteSession = "01a015e4-0477-7055-a0fd-21a0f72a4ec8";
    await git(repo, [
      "commit",
      "--allow-empty",
      "-m",
      `Imported\n\nAgent-Session: ${remoteSession}`,
    ]);
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    clearTraceEnvCache();

    expect(await prePush()).toBe(0);
    expect(
      await readFile(
        path.join(bucket, "by-session", sessionId, "trace.jsonl"),
        "utf8",
      ),
    ).toBe(transcript);

    const mapping = JSON.parse(
      await readFile(path.join(bucket, "by-commit", `${sha}.json`), "utf8"),
    );

    expect(mapping.sessions).toContain(remoteSession);
    expect(stderrText).toBe(
      `trace-sync: skipping ${remoteSession}: no local transcript.\n`,
    );
  });

  it("detaches the hosted publish instead of uploading inside the push", async () => {
    await selectHosted();
    const sessionsRoot = path.join(repo, ".codex", "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      path.join(
        sessionsRoot,
        "rollout-test-01a015e4-0477-7055-a0fd-21a0f72a4ec9.jsonl",
      ),
      "{}\n",
    );
    await git(repo, [
      "commit",
      "--allow-empty",
      "-m",
      "Imported change\n\nAgent-Session: 01a015e4-0477-7055-a0fd-21a0f72a4ec8",
    ]);

    // A failed OpenCode export must not block the later Codex session.
    const bin = path.join(repo, "bin");
    const exportMarker = path.join(repo, "opencode-exported");
    vi.stubEnv("OPENCODE_EXPORT_MARKER", exportMarker);
    await mkdir(bin);
    await writeFile(
      path.join(bin, "opencode"),
      '#!/bin/sh\ntouch "$OPENCODE_EXPORT_MARKER"\nexit 1\n',
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    await git(repo, [
      "commit",
      "--allow-empty",
      "-m",
      "OpenCode change\n\nAgent-Session: ses_local_opencode",
    ]);

    const spawned = vi
      .spyOn(hookRunner, "spawnDetachedTraceSync")
      .mockImplementation(() => undefined);

    expect(await prePush({ file: "/opt/whiteboard" })).toBe(0);
    expect(spawned).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "01a015e4-0477-7055-a0fd-21a0f72a4ec9",
        cwd: repo,
        command: { file: "/opt/whiteboard" },
      }),
    );
    expect(spawned).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_local_opencode" }),
    );
    expect(spawned).toHaveBeenCalledTimes(2);
    await expect(access(exportMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(stderrText).not.toContain("opencode export");
    expect(stderrText).not.toContain("No local trace");
  });
});
