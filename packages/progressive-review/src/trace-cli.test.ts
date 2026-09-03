import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import { StoreApiError, type StoreClient } from "./store-client";
import {
  runReviewTraceAllow,
  runReviewTraceLookupBlame,
  runReviewTraceLookupCommit,
  runReviewTraceLookupSession,
  runReviewTraceOnboard,
  runReviewTracePull,
  runReviewTraceStatus,
  runReviewTraceSync,
} from "./trace-cli";
import { traceRepositoryStatus } from "./trace-repository-hooks";
import {
  type MemoryTraceStoreTransport,
  createMemoryTraceStoreTransport,
  memoryTraceSessionKey,
} from "./trace-store-transport";
import {
  allowTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

/** A StoreClient double built from a partial method set. */
function fakeStoreClient(overrides: Partial<StoreClient>): StoreClient {
  return overrides as StoreClient;
}

function outputs() {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    stdout: collectingWritable(outChunks),
    stderr: collectingWritable(errChunks),
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

describe("trace-cli", () => {
  let tempDir: string;
  let localTraceRoot: string;
  let corpusRoot: string;
  let tmpHome: string;
  let cwd: string;
  let transport: MemoryTraceStoreTransport;

  function repoWithRemote(remoteUrl: string): string {
    const dir = path.join(
      tempDir,
      `repo-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
    return dir;
  }

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `trace-cli-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    localTraceRoot = path.join(tempDir, "local-traces");
    corpusRoot = path.join(tempDir, "trace-search");
    tmpHome = path.join(tempDir, "dev-home");
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(localTraceRoot, { recursive: true });
    mkdirSync(corpusRoot, { recursive: true });
    mkdirSync(tmpHome, { recursive: true });
    process.env.TRACE_LOCAL_TRACE_ROOT = localTraceRoot;
    process.env.REVIEW_TEST_TRACE_SEARCH_DIR = corpusRoot;
    process.env.DEV_REVIEW_HOME = tmpHome;
    transport = createMemoryTraceStoreTransport();
    cwd = repoWithRemote("git@github.com:acme/app.git");
  });

  afterEach(() => {
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    delete process.env.REVIEW_TEST_TRACE_SEARCH_DIR;
    delete process.env.DEV_REVIEW_HOME;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles husky git hook delegation without breaking core.hooksPath", async () => {
    const { stdout, stderr } = outputs();
    const repo = repoWithRemote("git@github.com:acme/husky-app.git");

    const huskyDir = path.join(repo, ".husky");
    mkdirSync(path.join(huskyDir, "_"), { recursive: true });
    writeFileSync(
      path.join(huskyDir, "_", "prepare-commit-msg"),
      "#!/bin/sh\nexit 0\n",
    );
    writeFileSync(path.join(huskyDir, "_", "pre-push"), "#!/bin/sh\nexit 0\n");
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], {
      cwd: repo,
    });

    const client = fakeStoreClient({
      findStore: vi.fn<StoreClient["findStore"]>(async () => ({
        repositoryId: 1,
        displayName: "acme/husky-app",
        status: "active",
        createdAt: "2026-09-02T00:00:00Z",
      })),
    });

    const exitCode = await runReviewTraceAllow({
      cwd: repo,
      stdout,
      stderr,
      client,
      homeDir: repo,
      harnessHooks: false,
    });

    expect(exitCode).toBe(0);
    const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
      cwd: repo,
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
    expect(managedHook).not.toContain(repo);
  });

  it("runs status and reports login and repository state", async () => {
    const { stdout, stderr, out } = outputs();

    const exitCode = await runReviewTraceStatus({ cwd, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(out()).toContain("You are not logged in");
    expect(out()).toContain("not allowed");
  });

  it("onboards the repo behind the remote", async () => {
    const { stdout, stderr, out } = outputs();
    const client = fakeStoreClient({
      createStore: vi.fn<StoreClient["createStore"]>(async () => ({
        repositoryId: 123,
        displayName: "acme/app",
        status: "active",
        createdAt: "2026-09-02T00:00:00Z",
        created: true,
      })),
    });

    const code = await runReviewTraceOnboard({
      cwd: repoWithRemote("git@github.com:acme/app.git"),
      stdout,
      stderr,
      client,
    });

    expect(code).toBe(0);
    expect(client.createStore).toHaveBeenCalledWith({
      owner: "acme",
      name: "app",
    });
    expect(out()).toContain("Run `review trace allow .`");
  });

  it("allow fails before onboarding", async () => {
    const { stdout, stderr, err } = outputs();
    const client = fakeStoreClient({
      findStore: vi.fn<StoreClient["findStore"]>(async () => null),
    });

    expect(await runReviewTraceAllow({ cwd, stdout, stderr, client })).toBe(1);
    expect(err()).toContain("review trace onboard");
  });

  it("allow records the entry and installs repo hooks", async () => {
    const { stdout, stderr } = outputs();
    const client = fakeStoreClient({
      findStore: vi.fn<StoreClient["findStore"]>(async () => ({
        repositoryId: 123,
        displayName: "acme/app",
        status: "active",
        createdAt: "2026-09-02T00:00:00Z",
      })),
    });

    expect(
      await runReviewTraceAllow({
        cwd,
        stdout,
        stderr,
        client,
        homeDir: tmpHome,
      }),
    ).toBe(0);
    expect(
      findTraceRepository(await readTraceUserConfig(), "acme/app")
        ?.repositoryId,
    ).toBe(123);
    expect((await traceRepositoryStatus(cwd)).enabled).toBe(true);
  });

  it("runs lookup commit and formats JSON and text outputs", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000001";
    transport.sessions.set(memoryTraceSessionKey(123, sessionId), {
      repositoryId: 123,
      sessionId,
      harness: "claude",
      updatedAt: "2026-09-02T12:00:00.000Z",
      commits: [sha],
      objects: [{ name: "main.jsonl.gz", size: 20, sha256: "0".repeat(64) }],
      complete: true,
    });

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
      transport,
      repositoryId: 123,
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
      transport,
      repositoryId: 123,
    });
    expect(exitCodeText).toBe(0);
    expect(textOut).toContain("via index");
    expect(textOut).toContain(sessionId);
  });

  it("runs lookup session and returns session meta or 404", async () => {
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000002";
    transport.sessions.set(memoryTraceSessionKey(123, sessionId), {
      repositoryId: 123,
      sessionId,
      harness: "claude",
      updatedAt: "2026-09-02T12:00:00.000Z",
      commits: ["1111111111111111111111111111111111111111"],
      objects: [{ name: "main.jsonl.gz", size: 20, sha256: "0".repeat(64) }],
      complete: true,
    });

    let jsonOut = "";
    const stdout = new PassThrough();
    stdout.on("data", (d) => {
      jsonOut += d.toString();
    });

    const exitCode = await runReviewTraceLookupSession({
      cwd,
      sessionId,
      json: true,
      stdout: stdout as any,
      transport,
      repositoryId: 123,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(jsonOut)).toMatchObject({
      session: sessionId,
      meta: { repo: "acme/app" },
    });

    // Unknown session
    let missingOut = "";
    const missingStdout = new PassThrough();
    missingStdout.on("data", (d) => {
      missingOut += d.toString();
    });
    const missingCode = await runReviewTraceLookupSession({
      cwd,
      sessionId: "99999999-aaaa-bbbb-cccc-000000000099",
      json: true,
      stdout: missingStdout as any,
      transport,
      repositoryId: 123,
    });
    expect(missingCode).toBe(1);
    expect(JSON.parse(missingOut)).toEqual({
      session: "99999999-aaaa-bbbb-cccc-000000000099",
      meta: null,
      has_raw_trace: false,
      subagents: [],
    });
  });

  it("runs sync and ships the local trace to the store", async () => {
    const sessionId = "11111111-aaaa-bbbb-cccc-000000000001";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );
    await allowTraceRepository({
      repositoryId: 123,
      name: "acme/app",
      store: "https://app.dev.fast",
    });

    let jsonOut = "";
    const stdout = new PassThrough();
    stdout.on("data", (d) => {
      jsonOut += d.toString();
    });

    const exitCode = await runReviewTraceSync({
      cwd,
      sessionId,
      json: true,
      stdout: stdout as any,
      stderr: new PassThrough() as any,
      transport,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(jsonOut)).toEqual({
      event: "trace.sync",
      sessionId,
      repositoryId: 123,
      stored: "written",
      objects: ["main.jsonl.gz"],
      commits: [],
    });
    expect(
      transport.objects.has(`r123/sessions/${sessionId}/main.jsonl.gz`),
    ).toBe(true);

    // Human output check
    let textOut = "";
    const stdoutText = new PassThrough();
    stdoutText.on("data", (d) => {
      textOut += d.toString();
    });
    await runReviewTraceSync({
      cwd,
      sessionId,
      stdout: stdoutText as any,
      stderr: new PassThrough() as any,
      transport,
    });
    expect(textOut).toContain("main.jsonl.gz  stored");
    expect(textOut).toContain("Shipped session");
  });

  it("sync reports a repository the user did not allow", async () => {
    const sessionId = "22222222-aaaa-bbbb-cccc-000000000002";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );
    const { stdout, stderr, err } = outputs();

    const exitCode = await runReviewTraceSync({
      cwd,
      sessionId,
      stdout,
      stderr,
      transport,
    });

    expect(exitCode).toBe(1);
    expect(err()).toContain("not allowed for trace publication");
  });

  it("pull reports why a store read failed", async () => {
    await allowTraceRepository({
      repositoryId: 123,
      name: "acme/app",
      store: "https://app.dev.fast",
    });
    const failing = {
      ...transport,
      listSessions: async () => {
        throw new StoreApiError("unauthorized", 401, "The token expired.");
      },
    };
    const { stdout, stderr, err } = outputs();

    const exitCode = await runReviewTracePull({
      cwd,
      session: "11111111-aaaa-bbbb-cccc-000000000001",
      stdout,
      stderr,
      transport: failing,
    });

    expect(exitCode).toBe(1);
    expect(err()).toContain(
      "Trace store request failed: unauthorized. Run `review login`.",
    );
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
