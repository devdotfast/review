import { describe, expect, it } from "vitest";

import {
  MAX_TRACE_OBJECT_BYTES,
  MAX_TRACE_SESSIONS_PAGE,
  MAX_TRACE_SESSION_BYTES,
  TRACE_STORE_API_PREFIX,
  beginUploadRequestSchema,
  beginUploadResponseSchema,
  completeUploadRequestSchema,
  completeUploadResponseSchema,
  createStoreRequestSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  sessionDownloadSchema,
  storeResponseSchema,
  traceObjectKey,
  traceObjectNameSchema,
  uploadManifestMismatch,
} from "./store-api.js";

const id = "0123456789abcdef0123456789abcdef";
const sha = "a".repeat(64);

describe("store-api contracts", () => {
  it("fixes the versioned prefix", () => {
    expect(TRACE_STORE_API_PREFIX).toBe("/api/trace/v1");
  });

  it("accepts main and subagent object names only", () => {
    expect(traceObjectNameSchema.safeParse("main.jsonl.gz").success).toBe(true);
    expect(
      traceObjectNameSchema.safeParse("subagents/agent-a1.jsonl.gz").success,
    ).toBe(true);
    expect(traceObjectNameSchema.safeParse("../x.jsonl.gz").success).toBe(
      false,
    );
    expect(
      traceObjectNameSchema.safeParse("subagents/a/b.jsonl.gz").success,
    ).toBe(false);
    expect(traceObjectNameSchema.safeParse("main.jsonl").success).toBe(false);
  });

  it("requires lowercase hex sha256 and positive size", () => {
    const ok = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [{ name: "main.jsonl.gz", size: 10, sha256: sha }],
    });
    expect(ok.success).toBe(true);
    const bad = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [{ name: "main.jsonl.gz", size: 0, sha256: "A".repeat(64) }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an object above the size cap", () => {
    const oversize = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [
        {
          name: "main.jsonl.gz",
          size: MAX_TRACE_OBJECT_BYTES + 1,
          sha256: sha,
        },
      ],
    });
    expect(oversize.success).toBe(false);
  });

  it("rejects duplicate names and a manifest above the session cap", () => {
    const duplicate = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [
        { name: "main.jsonl.gz", size: 10, sha256: sha },
        { name: "main.jsonl.gz", size: 11, sha256: sha },
      ],
    });
    expect(duplicate.success).toBe(false);
    const half = MAX_TRACE_SESSION_BYTES / 2;
    const total = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [
        { name: "main.jsonl.gz", size: half, sha256: sha },
        { name: "subagents/a.jsonl.gz", size: half, sha256: sha },
        { name: "subagents/b.jsonl.gz", size: 1, sha256: sha },
      ],
    });
    expect(total.success).toBe(false);
  });

  it("rejects a duplicate commit in a completion", () => {
    const commit = "b".repeat(40);
    expect(
      completeUploadRequestSchema.safeParse({ commits: [commit, commit] })
        .success,
    ).toBe(false);
    expect(completeUploadRequestSchema.parse({})).toEqual({ commits: [] });
  });

  it("names the upload in the begin response and the receipt", () => {
    expect(
      beginUploadResponseSchema.safeParse({
        storeId: id,
        baseGeneration: 0,
        uploads: [],
      }).success,
    ).toBe(false);
    expect(
      completeUploadResponseSchema.safeParse({
        sessionId: "session_1234",
        objects: [],
        commits: [],
      }).success,
    ).toBe(false);
    expect(
      completeUploadResponseSchema.safeParse({
        sessionId: "session_1234",
        uploadId: id,
        generation: 1,
        objects: [],
        commits: [],
      }).success,
    ).toBe(true);
  });

  it("finds every way a begin response can miss the manifest", () => {
    const manifest = [
      { name: "main.jsonl.gz" },
      { name: "subagents/a.jsonl.gz" },
    ];
    expect(uploadManifestMismatch(manifest, manifest)).toBeNull();
    expect(
      uploadManifestMismatch(manifest, [{ name: "main.jsonl.gz" }]),
    ).toContain("no upload for subagents/a.jsonl.gz");
    expect(
      uploadManifestMismatch(manifest, [
        ...manifest,
        { name: "main.jsonl.gz" },
      ]),
    ).toContain("twice");
    expect(
      uploadManifestMismatch(manifest, [
        ...manifest,
        { name: "subagents/b.jsonl.gz" },
      ]),
    ).toContain("did not declare");
  });

  it("places store and upload ids beneath the repository prefix", () => {
    expect(
      traceObjectKey({
        repositoryId: 42,
        storeId: id,
        sessionId: "session_1234",
        uploadId: id,
        name: "main.jsonl.gz",
      }),
    ).toBe(
      `r42/stores/${id}/sessions/session_1234/uploads/${id}/main.jsonl.gz`,
    );
    expect(() =>
      traceObjectKey({
        repositoryId: 42,
        storeId: "short",
        sessionId: "session_1234",
        uploadId: id,
        name: "main.jsonl.gz",
      }),
    ).toThrow(/storeId|Invalid|invalid/);
  });

  it("rejects owner/name with path characters", () => {
    expect(
      createStoreRequestSchema.safeParse({ owner: "a/b", name: "c" }).success,
    ).toBe(false);
  });
  it("accepts the optional byte counter on a store", () => {
    const base = {
      repositoryId: 1,
      storeId: id,
      displayName: "acme/app",
      status: "active",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(storeResponseSchema.safeParse(base).success).toBe(true);
    expect(
      storeResponseSchema.safeParse({ ...base, bytesStored: 12 }).success,
    ).toBe(true);
    expect(
      storeResponseSchema.safeParse({ ...base, bytesStored: -1 }).success,
    ).toBe(false);
  });

  it("carries optional branch and author through completion and listing", () => {
    expect(
      completeUploadRequestSchema.safeParse({
        commits: [],
        branch: "main",
        author: "dev@example.test",
      }).success,
    ).toBe(true);
    expect(
      completeUploadRequestSchema.safeParse({ commits: [], branch: null })
        .success,
    ).toBe(true);
    expect(
      completeUploadRequestSchema.safeParse({
        commits: [],
        branch: "x".repeat(201),
      }).success,
    ).toBe(false);
    const session = {
      sessionId: "session-0001",
      harness: "claude",
      uploadId: id,
      generation: 1,
      updatedAt: "2026-09-01T00:00:00.000Z",
      commits: [],
      objects: [],
    };
    expect(sessionDownloadSchema.safeParse(session).success).toBe(true);
    expect(
      sessionDownloadSchema.safeParse({
        ...session,
        branch: "main",
        author: null,
      }).success,
    ).toBe(true);
  });

  it("pages the session listing with a bounded limit and a session cursor", () => {
    const commit = "b".repeat(40);
    expect(listSessionsQuerySchema.safeParse({ commit }).success).toBe(true);
    expect(
      listSessionsQuerySchema.safeParse({
        commit,
        limit: "50",
        cursor: "session-0009",
      }).success,
    ).toBe(true);
    expect(
      listSessionsQuerySchema.safeParse({ commit, limit: "0" }).success,
    ).toBe(false);
    expect(
      listSessionsQuerySchema.safeParse({
        commit,
        limit: String(MAX_TRACE_SESSIONS_PAGE + 1),
      }).success,
    ).toBe(false);
    expect(
      listSessionsResponseSchema.safeParse({
        sessions: [],
        nextCursor: "session-0009",
      }).success,
    ).toBe(true);
  });
});
