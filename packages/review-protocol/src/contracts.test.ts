import { type JsonObject, jsonValueSchema } from "@dev.fast/json";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  REVIEW_SCHEMA_VERSION,
  ReviewCliInstallStampSchema,
  ReviewDescriptorSchema,
  ReviewDesktopDiscoverySchema,
  ReviewDesktopGlobalEventSchema,
  ReviewDesktopStateSchema,
  ReviewDesktopVerbFrameSchema,
  ReviewDesktopVerbResultSchema,
  ReviewDiffFileSchema,
  ReviewDiffFilesRequestSchema,
  ReviewDiffFilesResponseSchema,
  ReviewDocumentResponseSchema,
  ReviewEditorSelectionSchema,
  ReviewErrorResponseSchema,
  ReviewFileContentRequestSchema,
  ReviewFileContentResponseSchema,
  ReviewListResponseSchema,
  ReviewOpenEditorSchema,
  ReviewOpenResponseSchema,
  ReviewPublishReadyRequestSchema,
  ReviewRangeSchema,
  ReviewRecordSchema,
  ReviewRepositoryIdentitySchema,
  ReviewRuntimeConfigSchema,
  ReviewServerEventSchema,
  ReviewSessionDescriptorSchema,
  ReviewSessionLifecycleEventSchema,
  ReviewSessionResponseSchema,
  ReviewSessionSchema,
  ReviewSurfaceEventSchema,
  ReviewVerbRequestSchema,
  ReviewVerbResponseSchema,
  reviewViewSchema,
  summarizeReviewDiffFiles,
} from "./contracts.js";
import type { ReviewDocumentLoad, ReviewSoftwareMapLoad } from "./contracts.js";

it("accepts retryable busy errors through strict response envelopes", () => {
  const busy = {
    ok: false,
    code: "review_busy",
    retryable: true,
    error: "Review is busy",
  };

  expect(ReviewErrorResponseSchema.parse(busy)).toEqual(busy);
  expect(ReviewDocumentResponseSchema.parse(busy)).toEqual(busy);
  expect(
    ReviewErrorResponseSchema.safeParse({ ...busy, retryable: "yes" }).success,
  ).toBe(false);
});

const repository = {
  kind: "jj",
  repositoryId: "repo-1",
  repositoryPath: "/tmp/repo/.jj/repo",
  worktreeRoot: "/tmp/repo",
};

const reviewRecord = {
  schemaVersion: REVIEW_SCHEMA_VERSION,
  uuid: "3b241101-e2bb-4255-8caf-4136c566a962",
  repoKey: "repo-1",
  worktreePath: "/tmp/repo",
  baseRef: "main",
  baseCommit: "base-commit",
  sourceCommit: null,
  sourceIdentity: null,
  title: "Progressive Review",
  sourceSession: "disabled:review",
  status: "awaiting-review",
  presentedDocumentRevision: null,
  presentedSoftwareMapRevision: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  lastPublishedAt: null,
};

const descriptor = {
  sessionId: "session-1",
  sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
  reviewUuid: reviewRecord.uuid,
  routePath: "/",
  startedAt: 1,
};

const reviewDescriptor = {
  uuid: reviewRecord.uuid,
  title: reviewRecord.title,
  status: reviewRecord.status,
  worktreePath: reviewRecord.worktreePath,
  repoKey: reviewRecord.repoKey,
  sourceBranch: null,
  baseRef: "main",
  headRef: "feature",
  commits: [],
  pullRequestNumber: 673,
  pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
  diffStats: { fileCount: 3, additions: 58, deletions: 12 },
  documentUpdatedAt: "2026-07-29T12:00:00.000Z",
  presentedDocumentRevision: reviewRecord.presentedDocumentRevision,
  presentedSoftwareMapRevision: reviewRecord.presentedSoftwareMapRevision,
  lastPublishedAt: reviewRecord.lastPublishedAt,
  available: true,
};

const session = {
  sessionId: "session-1",
  rootPath: "/tmp/repo",
  baseRootPath: "/tmp/review-base",
  headRootPath: "/tmp/review-head",
  baseRef: "main",
  routePath: "/",
  appUrl: "http://127.0.0.1:5570/",
  sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
  reviewPath: "/tmp/repo/review.mdx",
  startedAt: 1,
};

const contracts: Array<[string, ZodType, JsonObject]> = [
  ["review record", ReviewRecordSchema, reviewRecord],
  ["review descriptor", ReviewDescriptorSchema, reviewDescriptor],
  [
    "CLI install stamp",
    ReviewCliInstallStampSchema,
    {
      consent: "skipped",
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
  ],
  [
    "runtime config",
    ReviewRuntimeConfigSchema,
    {
      serverUrl: "http://127.0.0.1:5570",
      sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
      routePath: "/",
      sessionId: "session-1",
      token: "",
      wasmUrl: "http://127.0.0.1:5570/libavoid.wasm",
      appVersion: "0.0.13",
      theme: "dark",
      host: "desktop",
    },
  ],
  [
    "desktop discovery",
    ReviewDesktopDiscoverySchema,
    {
      version: REVIEW_DESKTOP_DISCOVERY_VERSION,
      instanceId: "desktop-1",
      url: "http://127.0.0.1:5570",
      appPid: 1,
      serverPid: 2,
      token: "token",
      startedAt: 3,
    },
  ],
  ["repository identity", ReviewRepositoryIdentitySchema, repository],
  [
    "publish-ready request",
    ReviewPublishReadyRequestSchema,
    {
      reviewUuid: reviewRecord.uuid,
      revision: "a".repeat(40),
      agent: { harness: "codex", sessionId: "session-1" },
      view: "diff",
    },
  ],
  ["session descriptor", ReviewSessionDescriptorSchema, descriptor],
  [
    "open response",
    ReviewOpenResponseSchema,
    {
      sessionId: descriptor.sessionId,
      url: descriptor.sessionUrl,
      session: descriptor,
      review: reviewDescriptor,
    },
  ],
  [
    "review list",
    ReviewListResponseSchema,
    { reviews: [reviewDescriptor], errors: [] },
  ],
  [
    "session lifecycle event",
    ReviewSessionLifecycleEventSchema,
    { event: "ready", sessionId: "session-1" },
  ],
  [
    "desktop global event",
    ReviewDesktopGlobalEventSchema,
    { event: "session-updated", session: descriptor },
  ],
  [
    "desktop review data event",
    ReviewDesktopGlobalEventSchema,
    {
      event: "review-data-changed",
      uuid: reviewRecord.uuid,
      sessionId: descriptor.sessionId,
    },
  ],
  [
    "desktop review deleted event",
    ReviewDesktopGlobalEventSchema,
    {
      event: "review-deleted",
      uuid: reviewRecord.uuid,
    },
  ],
  ["session", ReviewSessionSchema, session],
  [
    "diff file",
    ReviewDiffFileSchema,
    {
      path: "src/index.ts",
      status: "modified",
      additions: 1,
      deletions: 2,
    },
  ],
  [
    "diff request",
    ReviewDiffFilesRequestSchema,
    {
      includePatch: true,
      paths: ["src/index.ts"],
      commit: "a".repeat(40),
    },
  ],
  [
    "diff response",
    ReviewDiffFilesResponseSchema,
    {
      ok: true,
      files: [
        {
          path: "src/index.ts",
          status: "modified",
          additions: 1,
          deletions: 2,
        },
      ],
    },
  ],
  [
    "file content request",
    ReviewFileContentRequestSchema,
    { path: "src/index.ts", side: "head" },
  ],
  [
    "file content response",
    ReviewFileContentResponseSchema,
    { ok: true, content: "" },
  ],
  [
    "session response",
    ReviewSessionResponseSchema,
    { ok: true, session, token: "token" },
  ],
  [
    "document response",
    ReviewDocumentResponseSchema,
    {
      ok: true,
      contentHash: "hash",
      documentUrl: "http://127.0.0.1:5570/documents/hash.json",
    },
  ],
  [
    "legacy error response",
    ReviewErrorResponseSchema,
    { ok: false, error: "bad" },
  ],
  [
    "server event",
    ReviewServerEventSchema,
    { event: "session-updated", session },
  ],
  ["range", ReviewRangeSchema, { fromLine: 1, toLine: 2 }],
  [
    "open editor",
    ReviewOpenEditorSchema,
    { path: "src/index.ts", scheme: "file" },
  ],
  [
    "editor selection",
    ReviewEditorSelectionSchema,
    {
      path: "src/index.ts",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    },
  ],
  [
    "desktop state",
    ReviewDesktopStateSchema,
    {
      openEditors: [{ path: "src/index.ts", scheme: "file" }],
      activeEditor: null,
      selection: null,
    },
  ],
  [
    "verb request",
    ReviewVerbRequestSchema,
    { name: "openFile", args: { path: "src/index.ts", line: 1 } },
  ],
  ["verb response", ReviewVerbResponseSchema, { ok: true }],
  [
    "desktop verb frame",
    ReviewDesktopVerbFrameSchema,
    {
      event: "desktop-verb",
      id: "verb-1",
      sessionId: "session-1",
      request: { name: "focusCanvas", args: {} },
    },
  ],
  [
    "desktop verb result",
    ReviewDesktopVerbResultSchema,
    {
      id: "verb-1",
      sessionId: "session-1",
      response: { ok: true },
    },
  ],
  [
    "surface event",
    ReviewSurfaceEventSchema,
    { event: "themeChanged", theme: "dark" },
  ],
];

describe("Review protocol Zod contracts", () => {
  it.each(contracts)("accepts a valid %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it("types republish detail by its code", () => {
    expect(
      ReviewDocumentResponseSchema.safeParse({
        ok: false,
        error: "Republish required",
        detail: {
          code: "needs_republish",
          reviewUuid: reviewRecord.uuid,
          mapStale: true,
        },
      }).success,
    ).toBe(true);

    // mapStale is meaningless without needs_republish, so it cannot be sent.
    expect(
      ReviewDocumentResponseSchema.safeParse({
        ok: false,
        error: "Gone",
        detail: {
          code: "historical_revision_unavailable",
          reviewUuid: reviewRecord.uuid,
          mapStale: true,
        },
      }).success,
    ).toBe(false);

    // A bare code and a structured detail are alternatives, not a pair.
    expect(
      ReviewDocumentResponseSchema.safeParse({
        ok: false,
        error: "Busy",
        code: "review_busy",
        detail: {
          code: "needs_republish",
          reviewUuid: reviewRecord.uuid,
          mapStale: false,
        },
      }).success,
    ).toBe(false);

    expect(
      ReviewDocumentResponseSchema.safeParse({
        ok: false,
        error: "Busy",
        code: "review_busy",
      }).success,
    ).toBe(true);
  });

  // Desktop discovery deliberately ignores unknown keys so future additive
  // fields never force another protocol version bump.
  const tolerantContracts = new Set(["desktop discovery"]);

  it.each(contracts)("rejects unknown keys in %s", (name, schema, value) => {
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(
      tolerantContracts.has(name),
    );
  });
});

describe("review canvas load states", () => {
  it("carries review payloads as JSON values", () => {
    const load = {
      state: "ready",
      contentHash: "h",
      data: { format: "review-document/1", body: [] },
    } satisfies ReviewDocumentLoad;

    expect(jsonValueSchema.safeParse(load.data).success).toBe(true);

    const maps = {
      state: "ready",
      contentHash: "h",
      head: { elements: [], relationships: [] },
      base: { elements: [], relationships: [] },
    } satisfies ReviewSoftwareMapLoad;

    expect(jsonValueSchema.safeParse(maps.head).success).toBe(true);

    const bad = {
      state: "ready",
      contentHash: "h",
      // @ts-expect-error data must be JSON
      data: new Date(),
    } satisfies ReviewDocumentLoad;

    expect(bad.data).toBeInstanceOf(Date);
  });

  it("keeps document and software-map loads independent", () => {
    const documentLoads = [
      { state: "ready", contentHash: "document-hash", data: {} },
      {
        state: "needs-republish",
        reviewUuid: reviewRecord.uuid,
        mapStale: true,
      },
      { state: "unavailable", message: "Document unavailable" },
    ] satisfies ReviewDocumentLoad[];

    const softwareMapLoads = [
      {
        state: "ready",
        contentHash: "map-hash",
        head: {},
        base: {},
      },
      { state: "needs-republish", reviewUuid: reviewRecord.uuid },
      { state: "unavailable", message: "Software map unavailable" },
    ] satisfies ReviewSoftwareMapLoad[];

    expect(documentLoads.map((load) => load.state)).toEqual([
      "ready",
      "needs-republish",
      "unavailable",
    ]);
    expect(softwareMapLoads.map((load) => load.state)).toEqual([
      "ready",
      "needs-republish",
      "unavailable",
    ]);
  });
});

describe("review views", () => {
  it("accepts the five shared views and rejects unknown values", () => {
    expect(
      ["review", "commits", "diff", "map", "trace"].every(
        (view) => reviewViewSchema.safeParse(view).success,
      ),
    ).toBe(true);
    expect(reviewViewSchema.safeParse("files").success).toBe(false);
    expect(
      ReviewVerbRequestSchema.safeParse({
        name: "showReviewView",
        args: { view: "diff" },
      }).success,
    ).toBe(true);
    expect(
      ReviewSurfaceEventSchema.safeParse({
        event: "showReviewView",
        view: "map",
      }).success,
    ).toBe(true);
  });
});

describe("review source identity", () => {
  it("stores the durable source identity separately from its Git commit", () => {
    const input = {
      ...reviewRecord,
      sourceIdentity: { kind: "jj-change", name: "rknkrlsrsmuu" },
      sourceCommit: "1".repeat(40),
    };

    const { sourceIdentity: _sourceIdentity, ...legacyRecord } = reviewRecord;

    expect(ReviewRecordSchema.safeParse(input).success).toBe(true);
    expect(
      ReviewRecordSchema.safeParse({
        ...legacyRecord,
        sourceBranch: "rknkrlsrsmuu",
      }).success,
    ).toBe(false);
  });
});

describe("summarizeReviewDiffFiles", () => {
  it("derives one aggregate for every Review diff surface", () => {
    expect(
      summarizeReviewDiffFiles([
        { additions: 7, deletions: 2 },
        { additions: 3, deletions: 5 },
      ]),
    ).toEqual({ fileCount: 2, additions: 10, deletions: 7 });
  });

  it("accepts the partial stats used by initial Review data", () => {
    expect(
      summarizeReviewDiffFiles([{ additions: 4 }, { deletions: 3 }]),
    ).toEqual({ fileCount: 2, additions: 4, deletions: 3 });
  });
});
