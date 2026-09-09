import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadReviewAgentTrace, syncReviewTrace } from "../review-agent-traces";
import { writeStoreAuth } from "../store-auth";
import {
  type TraceRepositoryTarget,
  traceTargetKey,
} from "../trace-repository-target";
import {
  recordTraceSessionProvenance,
  traceCaptureIdentity,
} from "../trace-session-provenance";
import {
  createMemoryTraceStoreTransport,
  seedMemoryTraceSession,
} from "../trace-store-transport";
import { allowTraceRepository } from "../trace-user-config";
import { traceConfigPath } from "./config";
import { HostedTraceStorage } from "./hosted";
import { resolveTraceStorage } from "./resolve";
import { clearTraceEnvCache } from "./s3-config";

const REPOSITORY_ID = 321;
const ORIGIN = "https://app.dev.fast";

function sessionRecord(sessionId: string, text: string): string {
  return [
    JSON.stringify({
      type: "session",
      id: sessionId,
      cwd: "/repo",
      timestamp: "2026-09-02T12:00:00Z",
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-09-02T12:00:05Z",
      message: { role: "user", content: text },
    }),
  ].join("\n");
}

describe("hosted trace storage", () => {
  let tempDir: string;
  let devHome: string;
  let corpusRoot: string;
  let localTraceRoot: string;
  let repoDir: string;
  let mockBucket: string;

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `hosted-storage-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    devHome = path.join(tempDir, "dev-home");
    corpusRoot = path.join(devHome, "trace-search");
    localTraceRoot = path.join(tempDir, "local-traces");
    repoDir = path.join(tempDir, "repo");
    mockBucket = path.join(tempDir, "mock-bucket");
    for (const dir of [
      devHome,
      corpusRoot,
      localTraceRoot,
      repoDir,
      mockBucket,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("TRACE_LOCAL_TRACE_ROOT", localTraceRoot);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", corpusRoot);
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
    clearTraceEnvCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearTraceEnvCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function target(storeId: string): TraceRepositoryTarget {
    return {
      origin: ORIGIN,
      repositoryId: REPOSITORY_ID,
      storeId,
      name: "acme/app",
    };
  }

  function writeConfig(value: JsonValue): void {
    const filePath = traceConfigPath({ devHome });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value));
  }

  it("refuses to publish without consent or provenance, then publishes", async () => {
    const sessionId = "hosted-session-0001";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${sessionRecord(sessionId, "hello")}\n`,
    );
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });

    await expect(
      syncReviewTrace({ sessionId, cwd: repoDir, storage }),
    ).rejects.toThrow(/not allowed for trace publication/);
    expect(transport.uploads.size).toBe(0);

    await allowTraceRepository(
      { repositoryId: REPOSITORY_ID, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    await expect(
      syncReviewTrace({ sessionId, cwd: repoDir, storage }),
    ).rejects.toThrow(/commit trailer does not authorize/);
    expect(transport.uploads.size).toBe(0);

    await recordTraceSessionProvenance({
      sessionId,
      ...traceCaptureIdentity({ target: target(transport.storeId) }),
      devHome,
    });
    const result = await syncReviewTrace({ sessionId, cwd: repoDir, storage });
    expect(result.hosted).toMatchObject({
      repositoryId: REPOSITORY_ID,
      generation: 1,
      complete: true,
      objects: ["main.jsonl.gz"],
    });
    expect(result.uploads).toEqual([
      {
        blob: "trace.jsonl",
        bytes_stored: expect.any(Number),
        status: "uploaded",
      },
    ]);
  });

  it("refreshes a saved copy when the content changes at the same size", async () => {
    const sessionId = "hosted-session-0002";
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "first")}\n` },
    });
    const first = await loadReviewAgentTrace({
      sessionId,
      cwd: repoDir,
      storage,
    });
    expect(
      first?.trace.events.map((event) => "text" in event && event.text),
    ).toEqual(["first"]);
    const cachePath = path.join(
      corpusRoot,
      traceTargetKey(target(transport.storeId)),
      sessionId,
      "main.jsonl",
    );
    expect(existsSync(cachePath)).toBe(true);
    const metadata = JSON.parse(readFileSync(cachePath, "utf8").split("\n")[0]);
    expect(metadata.source.storage).toBe(storage.cacheIdentity());
    expect(metadata.source.contentId).toMatch(/^sha256:[0-9a-f]{64}@1$/);

    // Same byte length, different content, new generation.
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "later")}\n` },
    });
    const second = await loadReviewAgentTrace({
      sessionId,
      cwd: repoDir,
      storage,
      refresh: true,
    });
    expect(
      second?.trace.events.map((event) => "text" in event && event.text),
    ).toEqual(["later"]);
  });

  it("never serves a hosted copy through s3 storage or a s3 copy as hosted", async () => {
    const sessionId = "hosted-session-0003";
    const transport = createMemoryTraceStoreTransport();
    const hosted = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "hosted")}\n` },
    });
    expect(
      await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage: hosted }),
    ).not.toBeNull();

    // An unscoped legacy copy under the classic owner/repo layout.
    const legacyDir = path.join(corpusRoot, "acme", "app", sessionId);
    mkdirSync(legacyDir, { recursive: true });
    const hostedCopy = path.join(
      corpusRoot,
      traceTargetKey(target(transport.storeId)),
      sessionId,
      "main.jsonl",
    );
    const legacyCopy = readFileSync(hostedCopy, "utf8")
      .split("\n")
      .map((line, index) => {
        if (index !== 0 || !line) return line;
        const record = JSON.parse(line);
        delete record.source.storage;
        delete record.source.contentId;
        return JSON.stringify(record);
      })
      .join("\n");
    writeFileSync(path.join(legacyDir, "main.jsonl"), legacyCopy);

    // Direct storage with nothing in its bucket: the hosted copy is not its.
    vi.stubEnv("TRACE_R2_MODE", "mock");
    vi.stubEnv("TRACE_R2_MOCK_DIR", mockBucket);
    clearTraceEnvCache();
    const s3 = await resolveTraceStorage({ cwd: repoDir });
    expect(s3?.kind).toBe("s3");
    const viaDirect = await loadReviewAgentTrace({
      sessionId,
      cwd: repoDir,
      repo: "acme/app",
      storage: s3,
    });
    // The legacy copy is s3's own and stays readable.
    expect(viaDirect?.descriptor.sessionId).toBe(sessionId);

    // The offline hosted storage sees only its own scope, not the legacy copy.
    rmSync(hostedCopy);
    const offline = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
      offline: true,
    });
    expect(
      await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage: offline }),
    ).toBeNull();
  });

  it("does not fall back to saved bucket credentials when hosted is selected and fails", async () => {
    const sessionId = "hosted-session-0004";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${sessionRecord(sessionId, "hello")}\n`,
    );
    vi.stubEnv("TRACE_R2_MODE", "mock");
    vi.stubEnv("TRACE_R2_MOCK_DIR", mockBucket);
    writeConfig({
      version: 2,
      "current-store": "hosted",
      stores: {
        s3: {
          endpoint: "https://s3.example.invalid",
          bucket: "legacy",
          accessKeyId: "k",
          secretAccessKey: "s",
        },
      },
    });
    clearTraceEnvCache();

    // No login: a hosted write cannot even resolve its target.
    await expect(syncReviewTrace({ sessionId, cwd: repoDir })).rejects.toThrow(
      /login|Log in|not logged in/i,
    );
    expect(readdirSync(mockBucket)).toEqual([]);

    // A login whose store does not answer: still no bucket write.
    await writeStoreAuth(
      {
        origin: ORIGIN,
        token: "t",
        login: "dev",
        savedAt: "2026-09-02T00:00:00Z",
      },
      process.env,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(syncReviewTrace({ sessionId, cwd: repoDir })).rejects.toThrow(
      /network down/,
    );
    expect(readdirSync(mockBucket)).toEqual([]);
  });
});
