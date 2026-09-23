import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectingWritable } from "./cli-output";
import { clearTraceEnvCache } from "./review-agent-traces";
import { runTraceList, runTracePull } from "./trace-read-cli";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("trace-read-cli", () => {
  let tempDir: string;
  let mockR2Dir: string;
  let searchDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "trace-read-cli-"));
    mockR2Dir = path.join(tempDir, "mock-r2");
    searchDir = path.join(tempDir, "trace-search");

    for (const [name, value] of Object.entries({
      TRACE_ENV_FILE: path.join(tempDir, "env"),
      DEV_WHITEBOARD_HOME: path.join(tempDir, ".dev"),
      TRACE_SETTINGS_FILE: path.join(tempDir, "settings.json"),
      TRACE_R2_MODE: "mock",
      TRACE_R2_MOCK_DIR: mockR2Dir,
      WHITEBOARD_TEST_TRACE_SEARCH_DIR: searchDir,
    }))
      vi.stubEnv(name, value);
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists a review scope's sessions from the change range it was given", async () => {
    const sessionId = "aaaa1111-bbbb-cccc-dddd-eeee00000001";
    const gitDir = path.join(tempDir, "repo");
    mkdirSync(gitDir, { recursive: true });
    git(gitDir, ["init", "--quiet"]);
    git(gitDir, ["config", "user.name", "Test"]);
    git(gitDir, ["config", "user.email", "test@test.com"]);
    writeFileSync(path.join(gitDir, "a.txt"), "base\n");
    git(gitDir, ["add", "a.txt"]);
    git(gitDir, ["commit", "-m", "Base commit"]);
    const baseCommit = git(gitDir, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(gitDir, "app.ts"), "const x = 1;\n");
    git(gitDir, ["add", "app.ts"]);
    git(gitDir, ["commit", "-m", `Add app\n\nAgent-Session: ${sessionId}`]);
    const headCommit = git(gitDir, ["rev-parse", "HEAD"]);

    const review = {
      uuid: "0f9d2c3e-1111-4222-8333-444455556666",
      repoRoot: gitDir,
      baseCommit,
      headCommit,
    };

    async function listReview(
      headCommit: string,
      json = false,
    ): Promise<string> {
      const out: string[] = [];

      const code = await runTraceList({
        cwd: gitDir,
        scope: { review: { ...review, headCommit } },
        json,
        stdout: collectingWritable(out),
      });

      expect(code).toBe(0);

      return out.join("");
    }

    expect(JSON.parse(await listReview(headCommit, true))).toEqual({
      review: review.uuid,
      sessions: [
        {
          id: sessionId,
          harness: "unknown",
          available: false,
          traces: ["main"],
          commits: [{ sha: headCommit, subject: "Add app" }],
        },
      ],
    });

    expect(await listReview(headCommit)).toBe(
      `${sessionId}  (unknown, not synced)\n  commit ${headCommit.slice(0, 9)}  Add app\n`,
    );

    expect(await listReview(baseCommit)).toBe(
      `No agent sessions recorded for review ${review.uuid}.\n`,
    );
  });

  it("pulls one session by id into the corpus", async () => {
    const sessionId = "11111111-aaaa-bbbb-cccc-000000000010";
    const key = path.join(mockR2Dir, "by-session", sessionId);
    mkdirSync(key, { recursive: true });
    writeFileSync(
      path.join(key, "trace.jsonl"),
      `${JSON.stringify({ type: "session", id: sessionId, cwd: "/repo", timestamp: "2026-09-02T12:00:00Z" })}\n`,
    );
    writeFileSync(
      path.join(key, "meta.json"),
      JSON.stringify({
        session: sessionId,
        repo: "acme/widgets",
        branch: null,
        pr: null,
        commits: [],
        author: null,
        ts: "2026-09-02T12:00:00Z",
      }),
    );

    const out: string[] = [];
    const err: string[] = [];

    const code = await runTracePull({
      cwd: tempDir,
      scope: { session: sessionId },
      repo: "acme/widgets",
      json: true,
      stdout: collectingWritable(out),
      stderr: collectingWritable(err),
    });

    expect(code).toBe(0);
    expect(err.join("")).toBe("");
    const parsed = JSON.parse(out.join("").trim());

    const expectedPath = path.join(
      searchDir,
      "acme",
      "widgets",
      sessionId,
      "main.jsonl",
    );

    expect(parsed).toEqual({
      scope: { session: sessionId },
      corpus_root: searchDir,
      repository: "acme/widgets",
      sessions: [{ session: sessionId, traces: 1, events: 0, files: 1 }],
      unavailable_sessions: [],
      events: 0,
      files: 1,
      paths: [expectedPath],
    });
    expect(existsSync(expectedPath)).toBe(true);

    const missingErr: string[] = [];

    const missingCode = await runTracePull({
      cwd: tempDir,
      scope: { session: "99999999-aaaa-bbbb-cccc-000000000099" },
      repo: "acme/widgets",
      stdout: collectingWritable([]),
      stderr: collectingWritable(missingErr),
    });

    expect(missingCode).toBe(1);
    expect(missingErr.join("")).toBe(
      "Unavailable sessions: 99999999-aaaa-bbbb-cccc-000000000099\n",
    );
  });
});
