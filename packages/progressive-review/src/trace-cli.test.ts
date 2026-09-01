import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import {
  runReviewTraceDoctor,
  runReviewTraceEnable,
  runReviewTraceLookupBlame,
  runReviewTraceLookupCommit,
  runReviewTraceLookupSession,
  runReviewTraceSync,
} from "./trace-cli";
import { configureTraceMachine } from "./trace-machine-setup";

describe("trace-cli", () => {
  let tempDir: string;
  let envFile: string;
  let mockR2Dir: string;
  let localTraceRoot: string;

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `trace-cli-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    envFile = path.join(tempDir, "env");
    mockR2Dir = path.join(tempDir, "mock-r2");
    localTraceRoot = path.join(tempDir, "local-traces");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(mockR2Dir, { recursive: true });
    mkdirSync(localTraceRoot, { recursive: true });
    process.env.TRACE_ENV_FILE = envFile;
    process.env.TRACE_SETTINGS_FILE = path.join(tempDir, "settings.json");
    process.env.TRACE_R2_MODE = "mock";
    process.env.TRACE_R2_MOCK_DIR = mockR2Dir;
    process.env.TRACE_LOCAL_TRACE_ROOT = localTraceRoot;
    clearTraceEnvCache();
  });

  afterEach(() => {
    delete process.env.TRACE_ENV_FILE;
    delete process.env.TRACE_SETTINGS_FILE;
    delete process.env.TRACE_R2_MODE;
    delete process.env.TRACE_R2_MOCK_DIR;
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    clearTraceEnvCache();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes configuration to env file and verifies options", async () => {
    const status = await configureTraceMachine({
      credentials: {
        endpoint: "https://test-account.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        key: "test-key-id",
        secret: "test-secret-key",
      },
    });

    expect(status.enabled).toBe(true);
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain(
      'export TRACE_R2_ENDPOINT="https://test-account.r2.cloudflarestorage.com"',
    );
    expect(content).toContain('export TRACE_R2_BUCKET="test-bucket"');
    expect(content).toContain('export TRACE_R2_ACCESS_KEY_ID="test-key-id"');
    expect(content).toContain(
      'export TRACE_R2_SECRET_ACCESS_KEY="test-secret-key"',
    );
    // Without an explicit region the machine keeps R2's "auto" signing region.
    expect(content).toContain('export TRACE_R2_REGION="auto"');
    expect(status.region).toBe("auto");
  });

  it("stores an explicit S3 signing region", async () => {
    const status = await configureTraceMachine({
      credentials: {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        bucket: "test-bucket",
        key: "test-key-id",
        secret: "test-secret-key",
        region: "us-east-1",
      },
    });

    expect(readFileSync(envFile, "utf8")).toContain(
      'export TRACE_R2_REGION="us-east-1"',
    );
    expect(status.region).toBe("us-east-1");
  });

  it("fails setup when required options are missing in nonInteractive mode", async () => {
    await expect(
      configureTraceMachine({ credentials: { bucket: "test-bucket" } }),
    ).rejects.toThrow("Trace setup needs");
  });

  it("handles husky git hook delegation without breaking core.hooksPath", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const huskyDir = path.join(tempDir, ".husky");
    mkdirSync(path.join(huskyDir, "_"), { recursive: true });
    writeFileSync(
      path.join(huskyDir, "_", "prepare-commit-msg"),
      "#!/bin/sh\nexit 0\n",
    );
    writeFileSync(path.join(huskyDir, "_", "pre-push"), "#!/bin/sh\nexit 0\n");

    execFileSync("git", ["init"], { cwd: tempDir });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], {
      cwd: tempDir,
    });

    await configureTraceMachine({
      credentials: {
        endpoint: "https://test-account.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        key: "test-key-id",
        secret: "test-secret-key",
      },
    });
    const exitCode = await runReviewTraceEnable({
      cwd: tempDir,
      stdout: stdout as any,
      stderr: stderr as any,
    });

    expect(exitCode).toBe(0);
    const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
      cwd: tempDir,
    })
      .toString()
      .trim();
    expect(hooksPath).toContain("dev-fast/trace-hooks/hooks");
    const managedHook = readFileSync(
      path.join(hooksPath, "prepare-commit-msg"),
      "utf8",
    );
    expect(managedHook).toContain(
      'root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    );
    expect(managedHook).toContain(
      "previous=\"$root\"/'.husky/_/prepare-commit-msg'",
    );
    expect(managedHook).not.toContain(tempDir);
  });

  it("runs doctor in mock mode", async () => {
    let out = "";
    const stdout = new PassThrough();
    stdout.on("data", (d) => {
      out += d.toString();
    });
    const stderr = new PassThrough();

    const exitCode = await runReviewTraceDoctor({
      cwd: tempDir,
      stdout: stdout as any,
      stderr: stderr as any,
    });

    expect(exitCode).toBe(0);
    expect(out).toContain("Checking trace configuration");
  });

  it("runs lookup commit and formats JSON and text outputs", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000001";
    const commitDir = path.join(mockR2Dir, "by-commit");
    mkdirSync(commitDir, { recursive: true });
    writeFileSync(
      path.join(commitDir, `${sha}.json`),
      JSON.stringify({
        commit: sha,
        sessions: [sessionId],
        repo: "acme/widgets",
        pr: 12,
        branch: "feature-branch",
        indexed_by: "ci",
        ts: "2026-08-16T12:00:00Z",
      }),
    );

    // JSON mode
    let jsonOut = "";
    const stdoutJson = new PassThrough();
    stdoutJson.on("data", (d) => {
      jsonOut += d.toString();
    });
    const exitCodeJson = await runReviewTraceLookupCommit({
      cwd: tempDir,
      sha,
      json: true,
      stdout: stdoutJson as any,
    });
    expect(exitCodeJson).toBe(0);
    const parsed = JSON.parse(jsonOut);
    expect(parsed.commit).toBe(sha);
    expect(parsed.sessions).toEqual([sessionId]);
    expect(parsed.source).toBe("index");

    // Human text mode
    let textOut = "";
    const stdoutText = new PassThrough();
    stdoutText.on("data", (d) => {
      textOut += d.toString();
    });
    const exitCodeText = await runReviewTraceLookupCommit({
      cwd: tempDir,
      sha,
      stdout: stdoutText as any,
    });
    expect(exitCodeText).toBe(0);
    expect(textOut).toContain("via index PR #12");
    expect(textOut).toContain(sessionId);
  });

  it("runs lookup session and returns session meta or 404", async () => {
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000002";
    const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({
        session: sessionId,
        repo: "acme/widgets",
        branch: "main",
        pr: 10,
        commits: ["1111111111111111111111111111111111111111"],
        author: "alice@example.com",
        ts: "2026-08-16T12:00:00Z",
      }),
    );

    let jsonOut = "";
    const stdout = new PassThrough();
    stdout.on("data", (d) => {
      jsonOut += d.toString();
    });

    const exitCode = await runReviewTraceLookupSession({
      cwd: tempDir,
      sessionId,
      json: true,
      stdout: stdout as any,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(jsonOut)).toMatchObject({
      session: sessionId,
      meta: {
        repo: "acme/widgets",
      },
    });

    // Unknown session
    let missingOut = "";
    const missingStdout = new PassThrough();
    missingStdout.on("data", (d) => {
      missingOut += d.toString();
    });
    const missingCode = await runReviewTraceLookupSession({
      cwd: tempDir,
      sessionId: "99999999-aaaa-bbbb-cccc-000000000099",
      json: true,
      stdout: missingStdout as any,
    });
    expect(missingCode).toBe(1);
    expect(JSON.parse(missingOut)).toEqual({
      session: "99999999-aaaa-bbbb-cccc-000000000099",
      meta: null,
      has_raw_trace: false,
      subagents: [],
    });
  });

  it("runs sync and uploads local traces to R2 with truthful status", async () => {
    const sessionId = "11111111-aaaa-bbbb-cccc-000000000001";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );

    let jsonOut = "";
    const stdout = new PassThrough();
    stdout.on("data", (d) => {
      jsonOut += d.toString();
    });

    const exitCode = await runReviewTraceSync({
      cwd: tempDir,
      sessionId,
      repo: "acme/widgets",
      json: true,
      stdout: stdout as any,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(jsonOut);
    expect(parsed.session).toBe(sessionId);
    expect(parsed.repo).toBe("acme/widgets");
    expect(parsed.uploads).toEqual([
      {
        blob: "trace.jsonl",
        bytes_stored: expect.any(Number),
        status: "uploaded",
      },
    ]);

    // Human output check
    let textOut = "";
    const stdoutText = new PassThrough();
    stdoutText.on("data", (d) => {
      textOut += d.toString();
    });
    await runReviewTraceSync({
      cwd: tempDir,
      sessionId,
      repo: "acme/widgets",
      stdout: stdoutText as any,
    });
    expect(textOut).toContain("trace.jsonl");
    expect(textOut).toContain("bytes  unchanged");
    expect(textOut).not.toContain("indexed");
  });

  it("runs blame lookup and formats JSON and text outputs", async () => {
    const gitDir = path.join(tempDir, "cli-blame-repo");
    mkdirSync(gitDir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: gitDir,
    });

    writeFileSync(path.join(gitDir, "app.ts"), "const x = 1;\nconst y = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: gitDir });
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        "Add app\n\nAgent-Session: aaaa1111-bbbb-cccc-dddd-eeee00000001",
      ],
      { cwd: gitDir },
    );

    // JSON mode
    let jsonOut = "";
    const stdoutJson = new PassThrough();
    stdoutJson.on("data", (d) => {
      jsonOut += d.toString();
    });
    const exitCodeJson = await runReviewTraceLookupBlame({
      cwd: gitDir,
      file: "app.ts",
      lines: "1,2",
      json: true,
      stdout: stdoutJson as any,
      stderr: new PassThrough() as any,
    });
    expect(exitCodeJson).toBe(0);
    const parsed = JSON.parse(jsonOut);
    expect(parsed.file).toBe("app.ts");
    expect(parsed.range).toBe("1,2");
    expect(parsed.resolutions).toHaveLength(1);
    expect(parsed.resolutions[0].sessions).toContain(
      "aaaa1111-bbbb-cccc-dddd-eeee00000001",
    );

    // Human mode
    let textOut = "";
    const stdoutText = new PassThrough();
    stdoutText.on("data", (d) => {
      textOut += d.toString();
    });
    const exitCodeText = await runReviewTraceLookupBlame({
      cwd: gitDir,
      file: "app.ts",
      stdout: stdoutText as any,
      stderr: new PassThrough() as any,
    });
    expect(exitCodeText).toBe(0);
    expect(textOut).toContain("→ 1 session(s) via trailer");
    expect(textOut).toContain("aaaa1111-bbbb-cccc-dddd-eeee00000001");
  });
});
