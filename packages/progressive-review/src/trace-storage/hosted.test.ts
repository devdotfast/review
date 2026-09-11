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

import {
  clearTraceEnvCache,
  loadReviewAgentTrace,
  lookupReviewTraceSession,
  pullReviewTraceCorpus,
  syncReviewTrace,
} from "../review-agent-traces";
import { writeStoreAuth } from "../store-auth";
import { StoreApiError } from "../store-client";
import {
  type TraceRepositoryTarget,
  rememberTraceRepositoryTarget,
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
import { TraceStorageDeniedError } from "./types";

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
    vi.unstubAllGlobals();
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

  it("reports session metadata from the store listing", async () => {
    const sessionId = "hosted-session-0005";
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      commits: ["a".repeat(40)],
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "meta")}\n` },
    });
    const lookup = await lookupReviewTraceSession({ sessionId, storage });
    expect(lookup.meta).toMatchObject({
      session: sessionId,
      repo: "acme/app",
      commits: ["a".repeat(40)],
      branch: null,
      pr: null,
      author: null,
    });
    expect(lookup.meta?.ts).toEqual(expect.any(String));
    expect(lookup.has_raw_trace).toBe(true);
  });

  it("warns when the login is for another origin and serves saved copies", async () => {
    const sessionId = "hosted-session-0006";
    const transport = createMemoryTraceStoreTransport();
    await rememberTraceRepositoryTarget({
      cwd: repoDir,
      target: target(transport.storeId),
      checkout: "acme/app",
      devHome,
    });
    await writeStoreAuth(
      {
        origin: "https://other.dev.fast",
        token: "t",
        login: "dev",
        savedAt: "2026-09-02T00:00:00Z",
      },
      process.env,
    );
    const warnings: string[] = [];
    const storage = await HostedTraceStorage.resolve({
      cwd: repoDir,
      origin: ORIGIN,
      write: false,
      transport,
      onWarning: (message) => warnings.push(message),
    });
    expect(storage?.offline).toBe(true);
    expect(warnings).toEqual([
      expect.stringContaining(
        "logged in to https://other.dev.fast, not the selected store https://app.dev.fast",
      ),
    ]);
    expect(
      await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage }),
    ).toBeNull();
  });

  it("refuses to publish through a login for another origin", async () => {
    await writeStoreAuth(
      {
        origin: "https://other.dev.fast",
        token: "t",
        login: "dev",
        savedAt: "2026-09-02T00:00:00Z",
      },
      process.env,
    );
    await expect(
      HostedTraceStorage.resolve({
        cwd: repoDir,
        origin: ORIGIN,
        write: true,
        transport: createMemoryTraceStoreTransport(),
      }),
    ).rejects.toThrow(
      /logged in to https:\/\/other.dev.fast, not the selected store/,
    );
  });

  it("shows nothing when the store refuses, instead of an old copy", async () => {
    const sessionId = "hosted-session-0007";
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "cached")}\n` },
    });
    expect(
      await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage }),
    ).not.toBeNull();
    // Access is revoked: the store now answers forbidden.
    const listSessions = transport.listSessions;
    transport.listSessions = async () => {
      throw new StoreApiError(
        "forbidden",
        403,
        "You cannot use this repository.",
      );
    };
    // A later command resolves its own storage; the listing is not reused.
    const revoked = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    try {
      expect(
        await loadReviewAgentTrace({
          sessionId,
          cwd: repoDir,
          storage: revoked,
          refresh: true,
        }),
      ).toBeNull();
      // A lookup names the refusal instead of answering "no trace".
      await expect(
        lookupReviewTraceSession({ sessionId, storage: revoked }),
      ).rejects.toBeInstanceOf(TraceStorageDeniedError);
    } finally {
      transport.listSessions = listSessions;
    }
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

    // Same byte length, different content, new generation. A later command
    // resolves its own storage instance.
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "later")}\n` },
    });
    const second = await loadReviewAgentTrace({
      sessionId,
      cwd: repoDir,
      storage: HostedTraceStorage.fromParts({
        target: target(transport.storeId),
        transport,
        devHome,
      }),
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
  it.each([
    ["unauthorized", 401],
    ["forbidden", 403],
    ["store_deleted", 410],
  ] as const)(
    "reports %s at target resolution instead of serving another copy",
    async (code, status) => {
      // A hosted copy saved earlier, under this origin and repository.
      const sessionId = "hosted-session-0008";
      const transport = createMemoryTraceStoreTransport();
      const first = HostedTraceStorage.fromParts({
        target: target(transport.storeId),
        transport,
        devHome,
      });
      seedMemoryTraceSession(transport, {
        repositoryId: REPOSITORY_ID,
        sessionId,
        traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "cached")}\n` },
      });
      expect(
        await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage: first }),
      ).not.toBeNull();

      // Access is revoked: findStore answers forbidden.
      writeConfig({ version: 2, "current-store": "hosted" });
      clearTraceEnvCache();
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
        vi.fn(async () =>
          Response.json(
            {
              error: {
                code,
                message: "You cannot use this repository.",
              },
            },
            { status },
          ),
        ),
      );
      await expect(
        resolveTraceStorage({ cwd: repoDir, onWarning: () => undefined }),
      ).rejects.toBeInstanceOf(TraceStorageDeniedError);
      // The saved copy is not served through a null storage either.
      await expect(
        loadReviewAgentTrace({ sessionId, cwd: repoDir }),
      ).rejects.toBeInstanceOf(TraceStorageDeniedError);
    },
  );
  it.each([undefined, "hosted"] as const)(
    "requires a hosted target before reading saved copies (override %s)",
    async (storageOverride) => {
      const sessionId = "hosted-session-no-target";
      const transport = createMemoryTraceStoreTransport();
      seedMemoryTraceSession(transport, {
        repositoryId: REPOSITORY_ID,
        sessionId,
        traces: {
          "main.jsonl.gz": sessionRecord(sessionId, "private saved copy"),
        },
      });
      expect(
        await loadReviewAgentTrace({
          sessionId,
          storage: HostedTraceStorage.fromParts({
            target: target(transport.storeId),
            transport,
            devHome,
          }),
        }),
      ).not.toBeNull();
      writeConfig({
        version: 2,
        "current-store": storageOverride ? "s3" : "hosted",
        stores: {
          hosted: { origin: ORIGIN },
          s3: {
            endpoint: "https://s3.example.invalid",
            bucket: "old",
            accessKeyId: "k",
            secretAccessKey: "s",
          },
        },
      });
      await expect(
        resolveTraceStorage({
          cwd: repoDir,
          override: storageOverride,
          onWarning: () => undefined,
        }),
      ).rejects.toThrow(/review login/);
      writeConfig({ version: 2, "current-store": "hosted" });
      await expect(
        loadReviewAgentTrace({ sessionId, cwd: repoDir }),
      ).rejects.toThrow(/review login/);
    },
  );

  it.each(["main", "agent-a1"])(
    "forgets an authoritative removed %s object, including subsequent offline reads",
    async (trace) => {
      const sessionId = "hosted-session-removed";
      const transport = createMemoryTraceStoreTransport();
      const storage = (offline = false) =>
        HostedTraceStorage.fromParts({
          target: target(transport.storeId),
          transport,
          devHome,
          offline,
        });
      seedMemoryTraceSession(transport, {
        repositoryId: REPOSITORY_ID,
        sessionId,
        traces: {
          "main.jsonl.gz": sessionRecord(sessionId, "main"),
          "subagents/agent-a1.jsonl.gz": sessionRecord(sessionId, "subagent"),
        },
      });
      expect(
        await loadReviewAgentTrace({ sessionId, trace, storage: storage() }),
      ).not.toBeNull();
      if (trace === "main") transport.sessions.clear();
      else
        seedMemoryTraceSession(transport, {
          repositoryId: REPOSITORY_ID,
          sessionId,
          traces: { "main.jsonl.gz": sessionRecord(sessionId, "main") },
        });
      expect(
        await loadReviewAgentTrace({
          sessionId,
          trace,
          storage: storage(),
          refresh: true,
        }),
      ).toBeNull();
      expect(
        await loadReviewAgentTrace({ sessionId, trace, storage: storage() }),
      ).toBeNull();
      expect(
        await loadReviewAgentTrace({
          sessionId,
          trace,
          storage: storage(true),
        }),
      ).toBeNull();
      const main = await loadReviewAgentTrace({
        sessionId,
        storage: storage(),
      });
      expect(main !== null).toBe(trace !== "main");
    },
  );

  it("does not reuse a former store's copy after the store is recreated", async () => {
    const sessionId = "hosted-session-recreated";
    const old = createMemoryTraceStoreTransport({ storeId: "a".repeat(32) });
    seedMemoryTraceSession(old, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: {
        "main.jsonl.gz": sessionRecord(sessionId, "old private content"),
      },
    });
    expect(
      await loadReviewAgentTrace({
        sessionId,
        storage: HostedTraceStorage.fromParts({
          target: target(old.storeId),
          transport: old,
          devHome,
        }),
      }),
    ).not.toBeNull();
    const transport = createMemoryTraceStoreTransport({
      storeId: "b".repeat(32),
    });
    for (const offline of [true, false]) {
      expect(
        await loadReviewAgentTrace({
          sessionId,
          storage: HostedTraceStorage.fromParts({
            target: target(transport.storeId),
            transport,
            devHome,
            offline,
          }),
        }),
      ).toBeNull();
    }
  });

  it("does not return stale content when a download is denied", async () => {
    const sessionId = "hosted-session-download-denied";
    const transport = createMemoryTraceStoreTransport();
    const storage = () =>
      HostedTraceStorage.fromParts({
        target: target(transport.storeId),
        transport,
        devHome,
      });
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": sessionRecord(sessionId, "old") },
    });
    expect(
      await loadReviewAgentTrace({ sessionId, storage: storage() }),
    ).not.toBeNull();
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": sessionRecord(sessionId, "new") },
    });
    transport.getObject = async () => {
      throw new TraceStorageDeniedError("Access revoked");
    };
    await expect(
      loadReviewAgentTrace({ sessionId, storage: storage(), refresh: true }),
    ).rejects.toBeInstanceOf(TraceStorageDeniedError);
    await expect(
      loadReviewAgentTrace({ sessionId, storage: storage() }),
    ).rejects.toBeInstanceOf(TraceStorageDeniedError);
  });

  it("does not let a same-name consent entry authorize another repository id", async () => {
    const sessionId = "hosted-session-0009";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${sessionRecord(sessionId, "hello")}\n`,
    );
    // Consent for id 999 under the same display name as this target (321).
    await allowTraceRepository(
      { repositoryId: 999, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    await recordTraceSessionProvenance({
      sessionId,
      ...traceCaptureIdentity({ target: target(transport.storeId) }),
      devHome,
    });
    await expect(
      syncReviewTrace({ sessionId, cwd: repoDir, storage }),
    ).rejects.toThrow(/not allowed for trace publication/);
    expect(transport.uploads.size).toBe(0);
  });
  it("lists a session once per storage instance", async () => {
    const sessionId = "hosted-session-0010";
    const transport = createMemoryTraceStoreTransport();
    const listSessions = vi.spyOn(transport, "listSessions");
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: {
        "main.jsonl.gz": `${sessionRecord(sessionId, "main")}\n`,
        "subagents/agent-a1.jsonl.gz": `${sessionRecord(sessionId, "sub")}\n`,
      },
    });
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    const pulled = await pullReviewTraceCorpus({
      repo: { owner: "acme", repo: "app" },
      sessions: [{ id: sessionId }],
      storage,
    });
    expect(pulled.files).toBe(2);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("skips the upload when the store already holds identical objects and links new commits", async () => {
    const sessionId = "hosted-session-0011";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${sessionRecord(sessionId, "same")}\n`,
    );
    await allowTraceRepository(
      { repositoryId: REPOSITORY_ID, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    await recordTraceSessionProvenance({
      sessionId,
      ...traceCaptureIdentity({ target: target(transport.storeId) }),
      devHome,
    });
    const first = await syncReviewTrace({
      sessionId,
      cwd: repoDir,
      storage,
      commits: ["a".repeat(40)],
    });
    expect(first.uploads.map((upload) => upload.status)).toEqual(["uploaded"]);
    const putObject = vi.spyOn(transport, "putObject");
    const second = await syncReviewTrace({
      sessionId,
      cwd: repoDir,
      storage,
      commits: ["b".repeat(40)],
    });
    expect(second.uploads.map((upload) => upload.status)).toEqual([
      "unchanged",
    ]);
    expect(putObject).not.toHaveBeenCalled();
    expect(second.hosted?.uploadId).toBe(first.hosted?.uploadId);
    expect(second.hosted?.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(transport.uploads.size).toBe(1);
  });

  it("follows listing pages when a commit has many sessions", async () => {
    const transport = createMemoryTraceStoreTransport({ pageSize: 2 });
    const commit = "c".repeat(40);
    const ids = [1, 2, 3, 4, 5].map((index) => `hosted-session-page-${index}`);
    for (const id of ids) {
      seedMemoryTraceSession(transport, {
        repositoryId: REPOSITORY_ID,
        sessionId: id,
        commits: [commit],
        traces: { "main.jsonl.gz": `${sessionRecord(id, "p")}\n` },
      });
    }
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    const found = await storage.sessionsForCommit(commit);
    expect([...(found?.sessions ?? [])].sort()).toEqual(ids);
  });

  it("carries branch and author into the session metadata", async () => {
    const sessionId = "hosted-session-0012";
    execFileSync("git", ["commit", "--allow-empty", "--quiet", "-m", "init"], {
      cwd: repoDir,
    });
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${sessionRecord(sessionId, "labels")}\n`,
    );
    await allowTraceRepository(
      { repositoryId: REPOSITORY_ID, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const transport = createMemoryTraceStoreTransport();
    const storage = HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    });
    await recordTraceSessionProvenance({
      sessionId,
      ...traceCaptureIdentity({ target: target(transport.storeId) }),
      devHome,
    });
    await syncReviewTrace({ sessionId, cwd: repoDir, storage, commits: [] });
    const meta = await HostedTraceStorage.fromParts({
      target: target(transport.storeId),
      transport,
      devHome,
    }).sessionMeta(sessionId);
    expect(meta?.branch).toEqual(expect.any(String));
    expect(meta?.author).toEqual(expect.any(String));
  });
});
