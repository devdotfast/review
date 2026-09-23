import { type JsonObject } from "@dev.fast/json";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  WHITEBOARD_DESKTOP_DISCOVERY_VERSION,
  WHITEBOARD_SCHEMA_VERSION,
  WhiteboardCliInstallStampSchema,
  WhiteboardDesktopDiscoverySchema,
  WhiteboardDesktopStateSchema,
  WhiteboardDesktopVerbFrameSchema,
  WhiteboardDesktopVerbResultSchema,
  WhiteboardDiffFileSchema,
  WhiteboardDiffFilesRequestSchema,
  WhiteboardDiffFilesResponseSchema,
  WhiteboardEditorSelectionSchema,
  WhiteboardErrorResponseSchema,
  WhiteboardFileContentRequestSchema,
  WhiteboardFileContentResponseSchema,
  WhiteboardOpenEditorSchema,
  WhiteboardRangeSchema,
  WhiteboardRepositoryIdentitySchema,
  WhiteboardRuntimeConfigSchema,
  WhiteboardSurfaceEventSchema,
  WhiteboardVerbRequestSchema,
  WhiteboardVerbResponseSchema,
  summarizeWhiteboardDiffFiles,
  whiteboardViewSchema,
} from "./contracts.js";

const repository = {
  kind: "jj",
  repositoryId: "repo-1",
  repositoryPath: "/tmp/repo/.jj/repo",
  worktreeRoot: "/tmp/repo",
};

const whiteboardRecord = {
  schemaVersion: WHITEBOARD_SCHEMA_VERSION,
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
  whiteboardUuid: whiteboardRecord.uuid,
  routePath: "/",
  startedAt: 1,
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
  whiteboardPath: "/tmp/repo/review.mdx",
  startedAt: 1,
};

const contracts: Array<[string, ZodType, JsonObject]> = [
  [
    "CLI install stamp",
    WhiteboardCliInstallStampSchema,
    {
      consent: "skipped",
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
  ],
  [
    "runtime config",
    WhiteboardRuntimeConfigSchema,
    {
      serverUrl: "http://127.0.0.1:5570",
      sessionId: "review-1",
      token: "",
      wasmUrl: "http://127.0.0.1:5570/libavoid.wasm",
      appVersion: "0.0.13",
      theme: "dark",
      host: "desktop",
    },
  ],
  [
    "desktop discovery",
    WhiteboardDesktopDiscoverySchema,
    {
      version: WHITEBOARD_DESKTOP_DISCOVERY_VERSION,
      instanceId: "desktop-1",
      url: "http://127.0.0.1:5570",
      appPid: 1,
      serverPid: 2,
      token: "token",
      startedAt: 3,
    },
  ],
  ["repository identity", WhiteboardRepositoryIdentitySchema, repository],

  [
    "diff file",
    WhiteboardDiffFileSchema,
    {
      path: "src/index.ts",
      status: "modified",
      additions: 1,
      deletions: 2,
    },
  ],
  [
    "diff request",
    WhiteboardDiffFilesRequestSchema,
    {
      includePatch: true,
      paths: ["src/index.ts"],
      commit: "a".repeat(40),
    },
  ],
  [
    "diff response",
    WhiteboardDiffFilesResponseSchema,
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
    WhiteboardFileContentRequestSchema,
    { path: "src/index.ts", side: "head" },
  ],
  [
    "file content response",
    WhiteboardFileContentResponseSchema,
    { ok: true, content: "" },
  ],

  [
    "legacy error response",
    WhiteboardErrorResponseSchema,
    { ok: false, error: "bad" },
  ],

  ["range", WhiteboardRangeSchema, { fromLine: 1, toLine: 2 }],
  [
    "open editor",
    WhiteboardOpenEditorSchema,
    { path: "src/index.ts", scheme: "file" },
  ],
  [
    "editor selection",
    WhiteboardEditorSelectionSchema,
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
    WhiteboardDesktopStateSchema,
    {
      openEditors: [{ path: "src/index.ts", scheme: "file" }],
      activeEditor: null,
      selection: null,
    },
  ],
  [
    "verb request",
    WhiteboardVerbRequestSchema,
    { name: "focusCanvas", args: {} },
  ],
  ["verb response", WhiteboardVerbResponseSchema, { ok: true }],
  [
    "desktop verb frame",
    WhiteboardDesktopVerbFrameSchema,
    {
      event: "desktop-verb",
      id: "verb-1",
      request: { name: "focusCanvas", args: {} },
    },
  ],
  [
    "desktop verb result",
    WhiteboardDesktopVerbResultSchema,
    {
      id: "verb-1",
      response: { ok: true },
    },
  ],
  [
    "surface event",
    WhiteboardSurfaceEventSchema,
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

describe("review views", () => {
  it("accepts the five shared views and rejects unknown values", () => {
    expect(
      ["review", "commits", "diff", "map", "trace"].every(
        (view) => whiteboardViewSchema.safeParse(view).success,
      ),
    ).toBe(true);
    expect(whiteboardViewSchema.safeParse("files").success).toBe(false);
    expect(
      WhiteboardVerbRequestSchema.safeParse({
        name: "showWhiteboardView",
        args: { view: "diff" },
      }).success,
    ).toBe(true);
    expect(
      WhiteboardSurfaceEventSchema.safeParse({
        event: "showWhiteboardView",
        view: "map",
      }).success,
    ).toBe(true);
  });
});

describe("summarizeWhiteboardDiffFiles", () => {
  it("derives one aggregate for every Review diff surface", () => {
    expect(
      summarizeWhiteboardDiffFiles([
        { additions: 7, deletions: 2 },
        { additions: 3, deletions: 5 },
      ]),
    ).toEqual({ fileCount: 2, additions: 10, deletions: 7 });
  });

  it("accepts the partial stats used by initial Review data", () => {
    expect(
      summarizeWhiteboardDiffFiles([{ additions: 4 }, { deletions: 3 }]),
    ).toEqual({ fileCount: 2, additions: 4, deletions: 3 });
  });
});
