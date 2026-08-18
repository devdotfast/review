import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearTraceEnvCache,
  describeTraceSession,
  findLocalTrace,
  isTraceR2Configured,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  lookupReviewTraceBlame,
  lookupReviewTraceCommit,
  lookupReviewTraceSession,
  syncReviewTrace,
} from "./review-agent-traces";

describe("review-agent-traces", () => {
  let tempDir: string;
  let mockR2Dir: string;
  let searchDir: string;
  let localClaudeDir: string;
  let localCodexDir: string;
  let localPiDir: string;

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `trace-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mockR2Dir = path.join(tempDir, "mock-r2");
    searchDir = path.join(tempDir, "trace-search");
    localClaudeDir = path.join(tempDir, "local-claude");
    localCodexDir = path.join(tempDir, "local-codex");
    localPiDir = path.join(tempDir, "local-pi");

    mkdirSync(mockR2Dir, { recursive: true });
    mkdirSync(searchDir, { recursive: true });
    mkdirSync(localClaudeDir, { recursive: true });
    mkdirSync(localCodexDir, { recursive: true });
    mkdirSync(localPiDir, { recursive: true });

    process.env.TRACE_R2_MODE = "mock";
    process.env.TRACE_R2_MOCK_DIR = mockR2Dir;
    process.env.REVIEW_TEST_TRACE_SEARCH_DIR = searchDir;
    process.env.TRACE_LOCAL_TRACE_ROOT = localClaudeDir;
    process.env.TRACE_CODEX_SESSIONS_ROOT = localCodexDir;
    process.env.TRACE_PI_SESSIONS_ROOT = localPiDir;
    clearTraceEnvCache();
  });

  afterEach(() => {
    delete process.env.TRACE_R2_MODE;
    delete process.env.TRACE_R2_MOCK_DIR;
    delete process.env.REVIEW_TEST_TRACE_SEARCH_DIR;
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    delete process.env.TRACE_CODEX_SESSIONS_ROOT;
    delete process.env.TRACE_PI_SESSIONS_ROOT;
    clearTraceEnvCache();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports configured when in mock mode", () => {
    expect(isTraceR2Configured()).toBe(true);
  });

  it("describes a session as available when stored in mock R2", async () => {
    const sessionId = "72b3d130-2e72-41b6-8686-527a93d16647";
    const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "trace.jsonl"),
      JSON.stringify({
        type: "session",
        id: sessionId,
        cwd: "/repo",
        timestamp: "2026-08-16T12:00:00Z",
      }) + "\n",
    );

    const desc = await describeTraceSession({
      sessionId,
      commits: [
        { sha: "1111111111111111111111111111111111111111", subject: "feat" },
      ],
    });

    expect(desc.sessionId).toBe(sessionId);
    expect(desc.available).toBe(true);
    expect(desc.source).toBe("r2");
    expect(desc.notSynced).toBe(false);
  });

  it("marks session as notSynced when missing from R2", async () => {
    const sessionId = "88888888-2e72-41b6-8686-527a93d16647";
    const desc = await describeTraceSession({
      sessionId,
      commits: [
        { sha: "1111111111111111111111111111111111111111", subject: "feat" },
      ],
    });

    expect(desc.sessionId).toBe(sessionId);
    expect(desc.available).toBe(false);
    expect(desc.source).toBe(null);
    expect(desc.notSynced).toBe(true);
  });

  it("materializes main and subagent traces from R2", async () => {
    const sessionId = "72b3d130-2e72-41b6-8686-527a93d16647";
    const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
    const subagentsDir = path.join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    writeFileSync(
      path.join(sessionDir, "trace.jsonl"),
      [
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
    );

    writeFileSync(
      path.join(subagentsDir, "pi-run-0-sub1.jsonl"),
      [
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
    );

    // Load main trace
    const mainLoaded = await loadReviewAgentTrace({
      sessionId,
      repo: "acme/widgets",
    });
    expect(mainLoaded).not.toBeNull();
    expect(mainLoaded?.trace.userTurns).toBe(1);
    expect(mainLoaded?.subagents).toContain("pi-run-0-sub1");
    expect(mainLoaded?.traceName).toBeNull();

    // Load subagent trace
    const subLoaded = await loadReviewAgentTrace({
      sessionId,
      trace: "pi-run-0-sub1",
      repo: "acme/widgets",
    });
    expect(subLoaded).not.toBeNull();
    expect(subLoaded?.trace.userTurns).toBe(1);
    expect(subLoaded?.traceName).toBe("pi-run-0-sub1");
    expect(subLoaded?.trace.events[0]).toMatchObject({
      kind: "user",
      text: "Subagent task",
    });
  });

  it("looks up commit from R2 index when trailers are absent", async () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e";
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000001";
    const commitDir = path.join(mockR2Dir, "by-commit");
    mkdirSync(commitDir, { recursive: true });
    writeFileSync(
      path.join(commitDir, `${sha}.json`),
      JSON.stringify({
        commit: sha,
        sessions: [sessionId],
        repo: "acme/widgets",
        pr: 42,
        branch: "feature-branch",
        indexed_by: "ci",
        ts: "2026-08-16T12:00:00Z",
      }),
    );

    const result = await lookupReviewTraceCommit({
      cwd: tempDir,
      sha,
    });

    expect(result.commit).toBe(sha);
    expect(result.sessions).toEqual([sessionId]);
    expect(result.pr).toBe(42);
    expect(result.branch).toBe("feature-branch");
    expect(result.source).toBe("index");
  });

  it("looks up session metadata from R2", async () => {
    const sessionId = "12345678-aaaa-bbbb-cccc-000000000002";
    const sha1 = "1111111111111111111111111111111111111111";
    const sha2 = "2222222222222222222222222222222222222222";
    const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({
        session: sessionId,
        repo: "acme/widgets",
        branch: "main",
        pr: 10,
        commits: [sha1, sha2],
        author: "alice@example.com",
        ts: "2026-08-16T12:00:00Z",
      }),
    );

    const result = await lookupReviewTraceSession({ sessionId });
    expect(result.session).toBe(sessionId);
    expect(result.meta).toMatchObject({
      session: sessionId,
      repo: "acme/widgets",
      branch: "main",
      pr: 10,
      commits: [sha1, sha2],
      author: "alice@example.com",
    });
  });

  it("discovers local traces across Claude, Codex, and Pi layouts and syncs to R2 with truthful status", async () => {
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
    expect(claudeDiscovery?.subagentPaths).toHaveLength(1);

    // Initial sync uploads blobs
    const claudeSync = await syncReviewTrace({
      sessionId: claudeId,
      cwd: tempDir,
      repo: "acme/widgets",
    });
    expect(claudeSync.session).toBe(claudeId);
    expect(claudeSync.repo).toBe("acme/widgets");
    expect(claudeSync.uploads).toEqual([
      {
        blob: "trace.jsonl",
        bytes_stored: expect.any(Number),
        status: "uploaded",
      },
      {
        blob: "subagents/agent-sub1.jsonl",
        bytes_stored: expect.any(Number),
        status: "uploaded",
      },
    ]);
    expect(
      existsSync(path.join(mockR2Dir, "by-session", claudeId, "trace.jsonl")),
    ).toBe(true);

    // Second sync with unchanged files reports unchanged status
    const secondSync = await syncReviewTrace({
      sessionId: claudeId,
      cwd: tempDir,
      repo: "acme/widgets",
    });
    expect(secondSync.uploads).toEqual([
      {
        blob: "trace.jsonl",
        bytes_stored: expect.any(Number),
        status: "unchanged",
      },
      {
        blob: "subagents/agent-sub1.jsonl",
        bytes_stored: expect.any(Number),
        status: "unchanged",
      },
    ]);

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
    expect(piDiscovery?.subagentPaths).toEqual([
      {
        name: "pi-run-0-childage.jsonl",
        path: path.join(piChildRunDir, "session.jsonl"),
      },
    ]);
  });

  it("fails loudly when R2 data upload fails", async () => {
    const sessionId = "44444444-aaaa-bbbb-cccc-000000000004";
    writeFileSync(
      path.join(localClaudeDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );

    const blockPath = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(path.dirname(blockPath), { recursive: true });
    writeFileSync(blockPath, "blocker");

    await expect(
      syncReviewTrace({
        sessionId,
        cwd: tempDir,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow("Failed to upload");
  });

  it("fails loudly when session metadata upload fails", async () => {
    const sessionId = "55555555-aaaa-bbbb-cccc-000000000005";
    writeFileSync(
      path.join(localClaudeDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "session", id: sessionId }) + "\n",
    );

    // Block meta.json write by creating meta.json as a directory with read-only permissions
    const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const blockMetaPath = path.join(sessionDir, "meta.json");
    mkdirSync(blockMetaPath, { recursive: true });

    await expect(
      syncReviewTrace({
        sessionId,
        cwd: tempDir,
        repo: "acme/widgets",
      }),
    ).rejects.toThrow("Failed to update session metadata");
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

      // Write mock R2 entry that would differ (to ensure trailer wins first)
      const r2Entry = {
        commit: sha,
        sessions: ["99999999-aaaa-bbbb-cccc-000000000099"],
        repo: "acme/widgets",
        pr: null,
        branch: "main",
        indexed_by: "ci",
        ts: new Date().toISOString(),
      };
      const byCommitDir = path.join(mockR2Dir, "by-commit");
      mkdirSync(byCommitDir, { recursive: true });
      writeFileSync(
        path.join(byCommitDir, `${sha}.json`),
        JSON.stringify(r2Entry),
      );

      const result = await lookupReviewTraceCommit({ cwd: gitDir, sha });
      expect(result.source).toBe("trailer");
      expect(result.sessions).toEqual(["11111111-aaaa-bbbb-cccc-000000000001"]);
    });

    it("resolves direct R2 index when local trailers are absent", async () => {
      const gitDir = path.join(tempDir, "repo-index");
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: gitDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: gitDir,
      });

      writeFileSync(path.join(gitDir, "a.txt"), "hello");
      execFileSync("git", ["add", "a.txt"], { cwd: gitDir });
      execFileSync("git", ["commit", "-m", "Plain commit without trailer"], {
        cwd: gitDir,
      });

      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitDir,
        encoding: "utf8",
      }).trim();

      const r2Entry = {
        commit: sha,
        sessions: [
          "22222222-aaaa-bbbb-cccc-000000000002",
          "22222222-aaaa-bbbb-cccc-000000000002",
        ],
        repo: "acme/widgets",
        pr: 101,
        branch: "feature-branch",
        indexed_by: "hook",
        ts: new Date().toISOString(),
      };
      const byCommitDir = path.join(mockR2Dir, "by-commit");
      mkdirSync(byCommitDir, { recursive: true });
      writeFileSync(
        path.join(byCommitDir, `${sha}.json`),
        JSON.stringify(r2Entry),
      );

      // Session meta enrichment
      const sessionDir = path.join(
        mockR2Dir,
        "by-session",
        "22222222-aaaa-bbbb-cccc-000000000002",
      );
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        path.join(sessionDir, "meta.json"),
        JSON.stringify({
          session: "22222222-aaaa-bbbb-cccc-000000000002",
          repo: "acme/widgets",
          branch: "feature-branch",
          pr: 101,
          author: "dev@acme.test",
          commits: [sha],
          ts: new Date().toISOString(),
        }),
      );

      const result = await lookupReviewTraceCommit({ cwd: gitDir, sha });
      expect(result.source).toBe("index");
      expect(result.sessions).toEqual(["22222222-aaaa-bbbb-cccc-000000000002"]);
      expect(result.pr).toBe(101);
      expect(
        result.session_meta?.["22222222-aaaa-bbbb-cccc-000000000002"],
      ).toEqual({
        repo: "acme/widgets",
        branch: "feature-branch",
        pr: 101,
        author: "dev@acme.test",
      });
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
      });
      expect(result.source).toBe("pr-scan");
      expect(result.pr).toBe(42);
      expect(result.sessions).toEqual(["33333333-aaaa-bbbb-cccc-000000000003"]);
    });

    it("works offline locally when R2 is not configured", async () => {
      delete process.env.TRACE_R2_MODE;
      delete process.env.TRACE_R2_BUCKET;
      clearTraceEnvCache();

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
    it("reports metadata, raw trace availability, and subagent names", async () => {
      const sessionId = "99999999-aaaa-bbbb-cccc-000000000009";
      const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        path.join(sessionDir, "meta.json"),
        JSON.stringify({
          session: sessionId,
          repo: "acme/widgets",
          branch: "main",
          pr: null,
          commits: ["1".repeat(40)],
          author: "dev@acme.test",
          ts: new Date().toISOString(),
        }),
      );
      writeFileSync(path.join(sessionDir, "trace.jsonl"), "{}\n");
      const subDir = path.join(sessionDir, "subagents");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(path.join(subDir, "agent-planner.jsonl"), "{}\n");

      const sessionLookup = await lookupReviewTraceSession({ sessionId });
      expect(sessionLookup.session).toBe(sessionId);
      expect(sessionLookup.meta?.repo).toBe("acme/widgets");
      expect(sessionLookup.has_raw_trace).toBe(true);
      expect(sessionLookup.subagents).toContain("agent-planner");
    });
  });
});
