import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { traceObjectKey } from "@dev-fast/trace-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type TraceStoreAccess,
  describeTraceSession,
  findLocalTrace,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  lookupReviewTraceBlame,
  lookupReviewTraceCommit,
  lookupReviewTraceSession,
  syncReviewTrace,
} from "./review-agent-traces";
import {
  type MemoryTraceStoreTransport,
  createMemoryTraceStoreTransport,
  memoryTraceSessionKey,
} from "./trace-store-transport";
import { allowTraceRepository } from "./trace-user-config";

const REPOSITORY_ID = 42;

/** Puts one session with its trace objects into the memory store. */
function seedStoreSession(
  transport: MemoryTraceStoreTransport,
  input: {
    sessionId: string;
    traces: Record<string, string>;
    commits?: string[];
  },
): void {
  const objects = Object.entries(input.traces).map(([name, content]) => {
    const compressed = zlib.gzipSync(Buffer.from(content, "utf8"));
    const objectName =
      name === "main" ? "main.jsonl.gz" : `subagents/${name}.jsonl.gz`;
    transport.objects.set(
      traceObjectKey(REPOSITORY_ID, input.sessionId, objectName),
      compressed,
    );
    return {
      name: objectName,
      size: compressed.byteLength,
      sha256: "0".repeat(64),
    };
  });
  transport.sessions.set(
    memoryTraceSessionKey(REPOSITORY_ID, input.sessionId),
    {
      repositoryId: REPOSITORY_ID,
      sessionId: input.sessionId,
      harness: "claude",
      updatedAt: "2026-09-02T12:00:00.000Z",
      commits: input.commits ?? [],
      objects,
      complete: true,
    },
  );
}

describe("review-agent-traces", () => {
  let tempDir: string;
  let searchDir: string;
  let localClaudeDir: string;
  let localCodexDir: string;
  let localPiDir: string;
  let devHome: string;
  let repoDir: string;
  let transport: MemoryTraceStoreTransport;
  let access: TraceStoreAccess;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `trace-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    searchDir = path.join(tempDir, "trace-search");
    localClaudeDir = path.join(tempDir, "local-claude");
    localCodexDir = path.join(tempDir, "local-codex");
    localPiDir = path.join(tempDir, "local-pi");
    devHome = path.join(tempDir, "dev-home");
    repoDir = path.join(tempDir, "repo");
    for (const dir of [
      searchDir,
      localClaudeDir,
      localCodexDir,
      localPiDir,
      devHome,
      repoDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", searchDir);
    vi.stubEnv("TRACE_LOCAL_TRACE_ROOT", localClaudeDir);
    vi.stubEnv("TRACE_CODEX_SESSIONS_ROOT", localCodexDir);
    vi.stubEnv("TRACE_PI_SESSIONS_ROOT", localPiDir);

    execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
      { cwd: repoDir },
    );
    await allowTraceRepository({
      repositoryId: REPOSITORY_ID,
      name: "acme/widgets",
      store: "https://app.dev.fast",
    });

    transport = createMemoryTraceStoreTransport();
    access = { transport, repositoryId: REPOSITORY_ID };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("describes a session as available when the store holds it", async () => {
    const sessionId = "72b3d130-2e72-41b6-8686-527a93d16647";
    seedStoreSession(transport, {
      sessionId,
      traces: {
        main: `${JSON.stringify({
          type: "session",
          id: sessionId,
          cwd: "/repo",
          timestamp: "2026-08-16T12:00:00Z",
        })}\n`,
      },
    });

    const desc = await describeTraceSession(
      {
        sessionId,
        commits: [
          { sha: "1111111111111111111111111111111111111111", subject: "feat" },
        ],
      },
      access,
    );

    expect(desc.sessionId).toBe(sessionId);
    expect(desc.available).toBe(true);
    expect(desc.source).toBe("r2");
    expect(desc.notSynced).toBe(false);
  });

  it("marks a session as notSynced when the store has none", async () => {
    const desc = await describeTraceSession(
      {
        sessionId: "88888888-2e72-41b6-8686-527a93d16647",
        commits: [
          { sha: "1111111111111111111111111111111111111111", subject: "feat" },
        ],
      },
      access,
    );

    expect(desc.available).toBe(false);
    expect(desc.source).toBe(null);
    expect(desc.notSynced).toBe(true);
  });

  it("materializes main and subagent traces from the store", async () => {
    const sessionId = "72b3d130-2e72-41b6-8686-527a93d16647";
    seedStoreSession(transport, {
      sessionId,
      traces: {
        main: [
          JSON.stringify({
            type: "session",
            id: sessionId,
            cwd: "/repo",
            timestamp: "2026-08-16T12:00:00Z",
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-08-16T12:00:05Z",
            message: { role: "user", content: "Main task" },
          }),
        ].join("\n"),
        "pi-run-0-sub1": [
          JSON.stringify({
            type: "session",
            id: "sub-1",
            cwd: "/repo",
            timestamp: "2026-08-16T12:01:00Z",
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-08-16T12:01:05Z",
            message: { role: "user", content: "Subagent task" },
          }),
        ].join("\n"),
      },
    });

    const mainLoaded = await loadReviewAgentTrace({
      sessionId,
      repo: "acme/widgets",
      access,
    });
    expect(mainLoaded).not.toBeNull();
    expect(mainLoaded?.trace.userTurns).toBe(1);
    expect(mainLoaded?.subagents).toContain("pi-run-0-sub1");
    expect(mainLoaded?.traceName).toBeNull();

    const subLoaded = await loadReviewAgentTrace({
      sessionId,
      trace: "pi-run-0-sub1",
      repo: "acme/widgets",
      access,
    });
    expect(subLoaded).not.toBeNull();
    expect(subLoaded?.trace.userTurns).toBe(1);
    expect(subLoaded?.traceName).toBe("pi-run-0-sub1");
    expect(subLoaded?.trace.events[0]).toMatchObject({
      kind: "user",
      text: "Subagent task",
    });
  });

  it("looks up a commit through the store index when trailers are absent", async () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e";
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000001";
    seedStoreSession(transport, {
      sessionId,
      traces: { main: "{}\n" },
      commits: [sha],
    });

    const result = await lookupReviewTraceCommit({
      cwd: tempDir,
      sha,
      transport,
      repositoryId: REPOSITORY_ID,
    });

    expect(result.commit).toBe(sha);
    expect(result.sessions).toEqual([sessionId]);
    expect(result.source).toBe("index");
  });

  it("looks up session metadata from the store", async () => {
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000002";
    const sha = "1111111111111111111111111111111111111111";
    seedStoreSession(transport, {
      sessionId,
      traces: { main: "{}\n" },
      commits: [sha],
    });

    const result = await lookupReviewTraceSession({
      sessionId,
      cwd: repoDir,
      transport,
      repositoryId: REPOSITORY_ID,
    });

    expect(result.session).toBe(sessionId);
    expect(result.meta).toMatchObject({
      session: sessionId,
      repo: "acme/widgets",
      commits: [sha],
    });
    expect(result.has_raw_trace).toBe(true);
  });

  it("discovers local traces across Claude, Codex, and Pi layouts and ships them", async () => {
    // 1. Claude trace
    const claudeId = "11111111-aaaa-bbbb-cccc-000000000001";
    const claudeProjectDir = path.join(localClaudeDir, "-Users-dev-project");
    mkdirSync(claudeProjectDir, { recursive: true });
    writeFileSync(
      path.join(claudeProjectDir, `${claudeId}.jsonl`),
      JSON.stringify({ type: "session", id: claudeId }) + "\n",
    );
    const claudeSubDir = path.join(claudeProjectDir, claudeId, "subagents");
    mkdirSync(claudeSubDir, { recursive: true });
    writeFileSync(
      path.join(claudeSubDir, "agent-sub1.jsonl"),
      JSON.stringify({ type: "session", id: "sub1" }) + "\n",
    );

    const claudeDiscovery = await findLocalTrace(claudeId);
    expect(claudeDiscovery).not.toBeNull();
    expect(claudeDiscovery?.tracePath).toBe(
      path.join(claudeProjectDir, `${claudeId}.jsonl`),
    );
    expect(claudeDiscovery?.harness).toBe("claude");
    expect(claudeDiscovery?.subagentPaths).toHaveLength(1);

    const claudeSync = await syncReviewTrace({
      sessionId: claudeId,
      cwd: repoDir,
      transport,
    });
    expect(claudeSync.session).toBe(claudeId);
    expect(claudeSync.repo).toBe("acme/widgets");
    expect(claudeSync.stored).toBe("written");
    expect(claudeSync.objects).toEqual([
      "main.jsonl.gz",
      "subagents/agent-sub1.jsonl.gz",
    ]);
    expect(
      transport.objects.has(
        traceObjectKey(REPOSITORY_ID, claudeId, "main.jsonl.gz"),
      ),
    ).toBe(true);

    // 2. Codex rollout trace
    const codexId = "22222222-aaaa-bbbb-cccc-000000000002";
    const codexDateDir = path.join(localCodexDir, "2026", "08", "16");
    mkdirSync(codexDateDir, { recursive: true });
    writeFileSync(
      path.join(codexDateDir, `rollout-2026-08-16T12-00-00-${codexId}.jsonl`),
      JSON.stringify({ type: "session", id: codexId }) + "\n",
    );

    const codexDiscovery = await findLocalTrace(codexId);
    expect(codexDiscovery).not.toBeNull();
    expect(codexDiscovery?.tracePath).toContain(codexId);
    expect(codexDiscovery?.harness).toBe("codex");

    // 3. Pi trace with child run
    const piId = "33333333-aaaa-bbbb-cccc-000000000003";
    const piProjectDir = path.join(localPiDir, "project-slug");
    mkdirSync(piProjectDir, { recursive: true });
    const piTracePath = path.join(
      piProjectDir,
      `2026-08-16T12-00-00_${piId}.jsonl`,
    );
    writeFileSync(
      piTracePath,
      JSON.stringify({ type: "session", id: piId }) + "\n",
    );
    const piChildRunDir = path.join(
      piProjectDir,
      `2026-08-16T12-00-00_${piId}`,
      "childagent123456",
      "run-0",
    );
    mkdirSync(piChildRunDir, { recursive: true });
    writeFileSync(
      path.join(piChildRunDir, "session.jsonl"),
      JSON.stringify({ type: "session", id: "child1" }) + "\n",
    );

    const piDiscovery = await findLocalTrace(piId);
    expect(piDiscovery).not.toBeNull();
    expect(piDiscovery?.harness).toBe("pi");
    expect(piDiscovery?.subagentPaths).toEqual([
      {
        name: "pi-run-0-childage.jsonl",
        path: path.join(piChildRunDir, "session.jsonl"),
      },
    ]);
  });

  it("fails loudly when the store rejects an object", async () => {
    const sessionId = "44444444-aaaa-bbbb-cccc-000000000004";
    writeFileSync(
      path.join(localClaudeDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );
    const failing = {
      ...transport,
      putObject: async () => {
        throw new Error(
          "The trace store did not store main.jsonl.gz (HTTP 403: AccessDenied).",
        );
      },
    };

    await expect(
      syncReviewTrace({ sessionId, cwd: repoDir, transport: failing }),
    ).rejects.toThrow("The trace store did not store main.jsonl.gz");
  });

  it("refuses to sync a repository the user did not allow", async () => {
    const sessionId = "55555555-aaaa-bbbb-cccc-000000000005";
    writeFileSync(
      path.join(localClaudeDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );
    const otherRepo = path.join(tempDir, "other-repo");
    mkdirSync(otherRepo, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: otherRepo });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/other.git"],
      { cwd: otherRepo },
    );

    await expect(
      syncReviewTrace({ sessionId, cwd: otherRepo, transport }),
    ).rejects.toThrow("This repository is not allowed for trace publication.");
  });

  describe("lookupReviewTraceCommit cheapest-first ladder", () => {
    it("resolves local Agent-Session trailers with highest priority", async () => {
      const gitDir = path.join(tempDir, "repo-trailer");
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: gitDir,
      });

      writeFileSync(path.join(gitDir, "a.txt"), "hello");
      execFileSync("git", ["add", "a.txt"], { cwd: gitDir });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Initial commit\n\nAgent-Session: 11111111-aaaa-bbbb-cccc-000000000001",
        ],
        { cwd: gitDir },
      );

      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitDir,
        encoding: "utf8",
      }).trim();

      // A store record that would differ, to prove the trailer wins first.
      seedStoreSession(transport, {
        sessionId: "99999999-aaaa-bbbb-cccc-000000000099",
        traces: { main: "{}\n" },
        commits: [sha],
      });

      const result = await lookupReviewTraceCommit({
        cwd: gitDir,
        sha,
        transport,
        repositoryId: REPOSITORY_ID,
      });
      expect(result.source).toBe("trailer");
      expect(result.sessions).toEqual(["11111111-aaaa-bbbb-cccc-000000000001"]);
    });

    it("scans PR branch commits from fake origin when trailer and index are empty", async () => {
      const originBare = path.join(tempDir, "remote.git");
      const clientRepo = path.join(tempDir, "client-repo");

      execFileSync("git", ["init", "--bare", "--quiet", originBare]);
      execFileSync("git", ["clone", "--quiet", originBare, clientRepo]);
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: clientRepo,
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: clientRepo,
      });

      // Initial commit on main
      writeFileSync(path.join(clientRepo, "f.txt"), "base");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync("git", ["commit", "-m", "Base commit"], {
        cwd: clientRepo,
      });
      execFileSync("git", ["push", "--quiet", "origin", "HEAD:main"], {
        cwd: clientRepo,
      });

      // Branch commit with trailer
      execFileSync("git", ["checkout", "-b", "feature"], { cwd: clientRepo });
      writeFileSync(path.join(clientRepo, "f.txt"), "branch change");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Feature work\n\nAgent-Session: 33333333-aaaa-bbbb-cccc-000000000003",
        ],
        { cwd: clientRepo },
      );
      execFileSync(
        "git",
        ["push", "--quiet", "origin", "HEAD:refs/pull/42/head"],
        { cwd: clientRepo },
      );

      // Return to main and make a squash merge commit with subject ending in (#42)
      execFileSync("git", ["checkout", "main"], { cwd: clientRepo });
      writeFileSync(path.join(clientRepo, "f.txt"), "squashed branch change");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync("git", ["commit", "-m", "Merge pull request (#42)"], {
        cwd: clientRepo,
      });

      const squashSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: clientRepo,
        encoding: "utf8",
      }).trim();

      const result = await lookupReviewTraceCommit({
        cwd: clientRepo,
        sha: squashSha,
        transport,
        repositoryId: REPOSITORY_ID,
      });
      expect(result.source).toBe("pr-scan");
      expect(result.pr).toBe(42);
      expect(result.sessions).toEqual(["33333333-aaaa-bbbb-cccc-000000000003"]);
    });

    it("works offline when no store is reachable", async () => {
      const gitDir = path.join(tempDir, "offline-repo");
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: gitDir,
      });

      writeFileSync(path.join(gitDir, "a.txt"), "offline");
      execFileSync("git", ["add", "a.txt"], { cwd: gitDir });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Offline commit\n\nAgent-Session: 44444444-aaaa-bbbb-cccc-000000000004",
        ],
        { cwd: gitDir },
      );

      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitDir,
        encoding: "utf8",
      }).trim();

      const result = await lookupReviewTraceCommit({ cwd: gitDir, sha });
      expect(result.source).toBe("trailer");
      expect(result.sessions).toEqual(["44444444-aaaa-bbbb-cccc-000000000004"]);
    });
  });

  describe("listReviewTraceSessions squash-merge fallback", () => {
    it("scans PR branches when range commits carry no trailers", async () => {
      const originBare = path.join(tempDir, "range-remote.git");
      const clientRepo = path.join(tempDir, "range-client");

      execFileSync("git", ["init", "--bare", "--quiet", originBare]);
      execFileSync("git", ["clone", "--quiet", originBare, clientRepo]);
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: clientRepo,
      });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: clientRepo,
      });

      writeFileSync(path.join(clientRepo, "f.txt"), "base");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync("git", ["commit", "-m", "Base commit"], {
        cwd: clientRepo,
      });
      execFileSync("git", ["push", "--quiet", "origin", "HEAD:main"], {
        cwd: clientRepo,
      });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: clientRepo,
        encoding: "utf8",
      }).trim();

      execFileSync("git", ["checkout", "-b", "feature"], { cwd: clientRepo });
      writeFileSync(path.join(clientRepo, "f.txt"), "branch change");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Feature work\n\nAgent-Session: 55555555-aaaa-bbbb-cccc-000000000005",
        ],
        { cwd: clientRepo },
      );
      execFileSync(
        "git",
        ["push", "--quiet", "origin", "HEAD:refs/pull/7/head"],
        { cwd: clientRepo },
      );

      execFileSync("git", ["checkout", "main"], { cwd: clientRepo });
      writeFileSync(path.join(clientRepo, "f.txt"), "squashed branch change");
      execFileSync("git", ["add", "f.txt"], { cwd: clientRepo });
      execFileSync("git", ["commit", "-m", "Squash merged feature work (#7)"], {
        cwd: clientRepo,
      });
      const squashSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: clientRepo,
        encoding: "utf8",
      }).trim();

      const sessions = await listReviewTraceSessions({
        rootPath: clientRepo,
        baseCommit: baseSha,
        headCommit: squashSha,
      });
      expect(sessions.map((session) => session.sessionId)).toEqual([
        "55555555-aaaa-bbbb-cccc-000000000005",
      ]);
      expect(sessions[0]?.commits).toEqual([
        { sha: squashSha, subject: "Squash merged feature work (#7)" },
      ]);
    });

    it("returns nothing when the squash subject has no PR number", async () => {
      const gitDir = path.join(tempDir, "range-no-pr");
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: gitDir,
      });

      writeFileSync(path.join(gitDir, "a.txt"), "base");
      execFileSync("git", ["add", "a.txt"], { cwd: gitDir });
      execFileSync("git", ["commit", "-m", "Base commit"], { cwd: gitDir });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitDir,
        encoding: "utf8",
      }).trim();

      writeFileSync(path.join(gitDir, "a.txt"), "change");
      execFileSync("git", ["add", "a.txt"], { cwd: gitDir });
      execFileSync("git", ["commit", "-m", "Plain commit without trailer"], {
        cwd: gitDir,
      });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitDir,
        encoding: "utf8",
      }).trim();

      const sessions = await listReviewTraceSessions({
        rootPath: gitDir,
        baseCommit: baseSha,
        headCommit: headSha,
      });
      expect(sessions).toEqual([]);
    });
  });

  describe("lookupReviewTraceBlame", () => {
    it("blames lines and resolves unique commits in default mode and history mode", async () => {
      const gitDir = path.join(tempDir, "repo-blame");
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: gitDir,
      });

      writeFileSync(path.join(gitDir, "code.ts"), "line 1\nline 2\nline 3\n");
      execFileSync("git", ["add", "code.ts"], { cwd: gitDir });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Commit 1\n\nAgent-Session: 11111111-0000-0000-0000-000000000001",
        ],
        { cwd: gitDir },
      );

      writeFileSync(
        path.join(gitDir, "code.ts"),
        "line 1\nline 2 modified\nline 3\n",
      );
      execFileSync("git", ["add", "code.ts"], { cwd: gitDir });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          "Commit 2\n\nAgent-Session: 22222222-0000-0000-0000-000000000002",
        ],
        { cwd: gitDir },
      );

      // Default blame for line 2
      const blame = await lookupReviewTraceBlame({
        cwd: gitDir,
        file: "code.ts",
        lines: "2,2",
      });
      expect(blame.file).toBe("code.ts");
      expect(blame.range).toBe("2,2");
      expect(blame.resolutions).toHaveLength(1);
      expect(blame.resolutions[0].sessions).toEqual([
        "22222222-0000-0000-0000-000000000002",
      ]);

      // History blame for line 2 includes commit 2 and commit 1
      const historyBlame = await lookupReviewTraceBlame({
        cwd: gitDir,
        file: "code.ts",
        lines: "2,2",
        history: true,
      });
      expect(historyBlame.history).toBe(true);
      expect(historyBlame.resolutions).toHaveLength(2);
    });
  });

  describe("lookupReviewTraceSession", () => {
    it("reports store metadata, trace availability, and subagent names", async () => {
      const sessionId = "99999999-aaaa-bbbb-cccc-000000000009";
      seedStoreSession(transport, {
        sessionId,
        traces: { main: "{}\n", "agent-planner": "{}\n" },
        commits: ["1".repeat(40)],
      });

      const sessionLookup = await lookupReviewTraceSession({
        sessionId,
        cwd: repoDir,
        transport,
        repositoryId: REPOSITORY_ID,
      });
      expect(sessionLookup.session).toBe(sessionId);
      expect(sessionLookup.meta?.repo).toBe("acme/widgets");
      expect(sessionLookup.has_raw_trace).toBe(true);
      expect(sessionLookup.subagents).toContain("agent-planner");
    });
  });
});
