import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  CreateReviewCommentInputSchema,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  REVIEW_SCHEMA_VERSION,
  ReviewCliInstallStampSchema,
  ReviewCommentSchema,
  ReviewCommentTargetSchema,
  ReviewCommentThreadMapSchema,
  ReviewDescriptorSchema,
  ReviewDesktopDiscoverySchema,
  ReviewDesktopGlobalEventSchema,
  ReviewDesktopStateSchema,
  ReviewDesktopVerbFrameSchema,
  ReviewDesktopVerbResultSchema,
  ReviewDiffFileSchema,
  ReviewDiffFilesRequestSchema,
  ReviewDiffFilesResponseSchema,
  ReviewDocModuleResponseSchema,
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
  ReviewSessionMutationResponseSchema,
  ReviewSessionResponseSchema,
  ReviewSessionSchema,
  ReviewSubmissionRequestSchema,
  ReviewSubmissionResponseSchema,
  ReviewSubmissionWireSchema,
  ReviewSurfaceEventSchema,
  ReviewThreadAnchorSchema,
  ReviewThreadAnchorsResponseSchema,
  ReviewVerbRequestSchema,
  ReviewVerbResponseSchema,
  ThreadTargetSchema,
  createGitLabTextDiffPosition,
  summarizeReviewDiffFiles,
} from "./contracts.js";

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
  commentCount: 2,
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
const submission = {
  id: "submission-1",
  decision: "request-changes",
  createdAt: "2026-07-23T00:00:00.000Z",
  rootPath: "/tmp/repo",
  reviewPath: "/tmp/repo/review.mdx",
  documentRoute: "/",
  comments: [],
  prompt: "",
};
const anchor = {
  startLine: 1,
  endLine: 2,
  threadId: "thread-1",
  kind: "comment",
};
const commentTarget = {
  kind: "prose",
  label: "paragraph",
  hash: "12345678",
};
const comment = {
  locator: "prose:p:0:0:12345678",
  target: commentTarget,
  body: "Review this.",
};

const contracts: Array<[string, ZodType, Record<string, unknown>]> = [
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
      docRuntimeUrl: "vscode-file://review/doc-runtime.js",
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
    },
  ],
  ["session descriptor", ReviewSessionDescriptorSchema, descriptor],
  [
    "session mutation response",
    ReviewSessionMutationResponseSchema,
    { ok: true, session: descriptor },
  ],
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
  ["submission wire", ReviewSubmissionWireSchema, submission],
  [
    "session lifecycle event",
    ReviewSessionLifecycleEventSchema,
    {
      event: "submitted",
      sessionId: "session-1",
      submission,
    },
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
    "document module response",
    ReviewDocModuleResponseSchema,
    {
      ok: true,
      contentHash: "hash",
      moduleUrl: "http://127.0.0.1:5570/module.js",
    },
  ],
  ["error response", ReviewErrorResponseSchema, { ok: false, error: "bad" }],
  ["comment target", ReviewCommentTargetSchema, commentTarget],
  ["comment", ReviewCommentSchema, comment],
  [
    "submission request",
    ReviewSubmissionRequestSchema,
    {
      submissionId: "submission-1",
      decision: "request-changes",
      comments: [comment],
    },
  ],
  [
    "submission response",
    ReviewSubmissionResponseSchema,
    { ok: true, submissionId: "submission-1" },
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
  ["thread anchor", ReviewThreadAnchorSchema, anchor],
  [
    "thread anchors response",
    ReviewThreadAnchorsResponseSchema,
    {
      ok: true,
      files: [{ path: "src/index.ts", anchors: [anchor] }],
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

  // Desktop discovery deliberately ignores unknown keys so future additive
  // fields never force another protocol version bump.
  const tolerantContracts = new Set(["desktop discovery"]);

  it.each(contracts)("rejects unknown keys in %s", (name, schema, value) => {
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(
      tolerantContracts.has(name),
    );
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

describe("canonical comment contracts", () => {
  const position = createGitLabTextDiffPosition({
    base_sha: "0".repeat(40),
    start_sha: "0".repeat(40),
    head_sha: "1".repeat(40),
    old_path: "src/example.ts",
    new_path: "src/example.ts",
    start: { old_line: null, new_line: 3 },
    end: { old_line: null, new_line: 5 },
  });
  const target = {
    kind: "code" as const,
    original_position: position,
    position,
  } as const;

  it("accepts canonical code targets and comment records", () => {
    expect(ThreadTargetSchema.parse(target)).toEqual(target);
    expect(
      CreateReviewCommentInputSchema.parse({
        threadId: "thread-1",
        messageId: "message-1",
        target,
        body: "Check this range",
      }),
    ).toMatchObject({ target });
    expect(
      ReviewCommentThreadMapSchema.safeParse({
        "thread-1": {
          threadId: "thread-1",
          target,
          status: "open",
          messages: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete positions and mismatched map keys", () => {
    expect(
      ThreadTargetSchema.safeParse({
        ...target,
        position: { ...position, start_sha: null },
      }).success,
    ).toBe(false);
    expect(
      ReviewCommentThreadMapSchema.safeParse({
        "thread-1": {
          threadId: "thread-2",
          target,
          status: "open",
          messages: [],
        },
      }).success,
    ).toBe(false);
  });

  it("requires the immutable original position inside code targets", () => {
    const { original_position: _originalPosition, ...incompleteTarget } =
      target;
    expect(
      ReviewCommentThreadMapSchema.safeParse({
        "thread-1": {
          threadId: "thread-1",
          target: incompleteTarget,
          status: "open",
          messages: [],
        },
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
