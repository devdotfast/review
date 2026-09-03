import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { traceObjectKey } from "@dev-fast/trace-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pullReviewTraceCorpus, syncReviewTrace } from "./review-agent-traces";
import type { StoreClient } from "./store-client";
import {
  createHttpTraceStoreTransport,
  createMemoryTraceStoreTransport,
  gzipToTemp,
  memoryTraceSessionKey,
} from "./trace-store-transport";
import { allowTraceRepository } from "./trace-user-config";

const REPOSITORY_ID = 123;

describe("trace-store-transport", () => {
  let tempDir: string;
  let devHome: string;
  let localTraceRoot: string;
  let corpusRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `trace-transport-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    devHome = path.join(tempDir, "dev-home");
    localTraceRoot = path.join(tempDir, "local-traces");
    corpusRoot = path.join(tempDir, "trace-search");
    repoDir = path.join(tempDir, "repo");
    for (const dir of [devHome, localTraceRoot, corpusRoot, repoDir]) {
      mkdirSync(dir, { recursive: true });
    }
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", corpusRoot);
    vi.stubEnv("TRACE_LOCAL_TRACE_ROOT", localTraceRoot);

    execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repoDir },
    );
    await allowTraceRepository({
      repositoryId: REPOSITORY_ID,
      name: "acme/app",
      store: "https://app.dev.fast",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("gzips a file and reports size and sha256", async () => {
    const source = path.join(tempDir, "hello.jsonl");
    await writeFile(source, "hello\n", "utf8");

    const gzipped = await gzipToTemp(source);

    expect(gzipped.size).toBeGreaterThan(0);
    expect(gzipped.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(zlib.gunzipSync(await readFile(gzipped.path)).toString("utf8")).toBe(
      "hello\n",
    );

    await gzipped.cleanup();
    expect(existsSync(gzipped.path)).toBe(false);
  });

  it("puts the object with the presigned headers", async () => {
    const source = path.join(tempDir, "put.jsonl");
    await writeFile(source, "hello\n", "utf8");
    const gzipped = await gzipToTemp(source);
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const transport = createHttpTraceStoreTransport(
      {} as StoreClient,
      fetchImpl,
    );

    await transport.putObject(
      {
        name: "main.jsonl.gz",
        url: "https://r2.test/k?sig",
        headers: {
          "content-type": "application/gzip",
          "content-length": String(gzipped.size),
          "x-amz-checksum-sha256": "x",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      gzipped.path,
    );

    expect(fetchImpl.mock.calls[0][0]).toBe("https://r2.test/k?sig");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "x-amz-checksum-sha256": "x" }),
    });
    await gzipped.cleanup();
  });

  it("sync uploads main and subagent files then completes with trailer commits", async () => {
    const sessionId = "session-0001";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
    const subagentsDir = path.join(localTraceRoot, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-sub1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sub1" })}\n`,
    );
    writeFileSync(path.join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
    execFileSync(
      "git",
      ["commit", "-m", `Add a\n\nAgent-Session: ${sessionId}`],
      { cwd: repoDir },
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const transport = createMemoryTraceStoreTransport();

    const result = await syncReviewTrace({
      sessionId,
      cwd: repoDir,
      transport,
    });

    expect(
      transport.objects.has(
        `r${REPOSITORY_ID}/sessions/${sessionId}/main.jsonl.gz`,
      ),
    ).toBe(true);
    expect(
      transport.objects.has(
        `r${REPOSITORY_ID}/sessions/${sessionId}/subagents/agent-sub1.jsonl.gz`,
      ),
    ).toBe(true);
    expect(result.stored).toBe("written");
    expect(result.repositoryId).toBe(REPOSITORY_ID);
    expect(result.objects).toEqual([
      "main.jsonl.gz",
      "subagents/agent-sub1.jsonl.gz",
    ]);
    expect(result.commits).toEqual([sha]);
    expect(
      transport.sessions.get(memoryTraceSessionKey(REPOSITORY_ID, sessionId))
        ?.harness,
    ).toBe("claude");
  });

  it("pull downloads and normalizes into the corpus", async () => {
    const sessionId = "session-0002";
    const transport = createMemoryTraceStoreTransport();
    const trace = [
      JSON.stringify({
        type: "session",
        id: sessionId,
        cwd: "/repo",
        timestamp: "2026-09-02T12:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-02T12:00:05Z",
        message: { role: "user", content: "Build the feature" },
      }),
    ].join("\n");
    const compressed = zlib.gzipSync(Buffer.from(`${trace}\n`, "utf8"));
    transport.objects.set(
      traceObjectKey(REPOSITORY_ID, sessionId, "main.jsonl.gz"),
      compressed,
    );
    transport.sessions.set(memoryTraceSessionKey(REPOSITORY_ID, sessionId), {
      repositoryId: REPOSITORY_ID,
      sessionId,
      harness: "claude",
      updatedAt: "2026-09-02T12:00:10Z",
      commits: [],
      objects: [
        {
          name: "main.jsonl.gz",
          size: compressed.byteLength,
          sha256: "0".repeat(64),
        },
      ],
      complete: true,
    });

    const result = await pullReviewTraceCorpus({
      repo: { owner: "acme", repo: "app" },
      sessions: [{ id: sessionId }],
      cwd: repoDir,
      transport,
    });

    const corpusPath = path.join(
      corpusRoot,
      "acme",
      "app",
      sessionId,
      "main.jsonl",
    );
    expect(existsSync(corpusPath)).toBe(true);
    expect(result.paths).toEqual([corpusPath]);
    expect(result.sessions).toEqual([
      { session: sessionId, traces: 1, events: 1, files: 1 },
    ]);
  });
});
