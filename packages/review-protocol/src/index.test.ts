import { describe, expect, it } from "vitest";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  normalizeReviewRoutePath,
  parseReviewDesktopDiscovery,
  parseReviewDesktopState,
  parseReviewDesktopVerbFrame,
  parseReviewDesktopVerbResult,
  parseReviewDiffFilesResponse,
  parseReviewFileContentRequest,
  parseReviewFileContentResponse,
  parseReviewListResponse,
  parseReviewOpenResponse,
  parseReviewRuntimeConfig,
  parseReviewServerEvent,
  parseReviewSession,
  parseReviewSessionLifecycleEvent,
  parseReviewSessionResponse,
  parseReviewSurfaceEvent,
  parseReviewThreadAnchorsResponse,
  parseReviewVerbRequest,
} from "./index.js";

describe("review protocol parsers", () => {
  it("parses global desktop discovery and session-prefixed runtime URLs", () => {
    expect(
      parseReviewDesktopDiscovery({
        version: REVIEW_DESKTOP_DISCOVERY_VERSION,
        instanceId: "desktop-1",
        url: "http://127.0.0.1:5590/ignored",
        appPid: 10,
        serverPid: 11,
        token: "secret",
        startedAt: 12,
      }),
    ).toMatchObject({ url: "http://127.0.0.1:5590", instanceId: "desktop-1" });
    expect(
      parseReviewRuntimeConfig({
        serverUrl: "http://127.0.0.1:5590",
        sessionUrl: "http://127.0.0.1:5590/sessions/session-1/",
        routePath: "/",
        sessionId: "session-1",
        token: "secret",
        wasmUrl:
          "http://127.0.0.1:5590/sessions/session-1/assets/libavoid.wasm",
        docRuntimeUrl: "vscode-file://review/doc-runtime.js",
        appVersion: "0.0.13",
        theme: "light",
        host: "desktop",
      }).sessionUrl,
    ).toBe("http://127.0.0.1:5590/sessions/session-1");
    expect(() =>
      parseReviewDesktopDiscovery({
        version: REVIEW_DESKTOP_DISCOVERY_VERSION + 1,
        instanceId: "desktop-1",
        url: "http://127.0.0.1:5590",
        appPid: 10,
        serverPid: 11,
        token: "secret",
        startedAt: 12,
      }),
    ).toThrow("Unsupported");
  });

  it("parses lifecycle and correlated verb frames", () => {
    const descriptor = {
      sessionId: "session-1",
      sessionUrl: "http://127.0.0.1:5590/sessions/session-1",
      reviewUuid: "3b241101-e2bb-4255-8caf-4136c566a962",
      routePath: "/",
      startedAt: 10,
    };
    expect(
      parseReviewListResponse({
        reviews: [
          {
            uuid: descriptor.reviewUuid,
            title: "Protocol rewrite",
            status: "awaiting-review",
            worktreePath: "/tmp/repo",
            repoKey: "repo-1",
            sourceBranch: "feature/protocol",
            presentedDocumentRevision: null,
            presentedSoftwareMapRevision: null,
            lastPublishedAt: null,
            available: true,
          },
        ],
        errors: [],
      }),
    ).toMatchObject({ reviews: [{ title: "Protocol rewrite" }] });
    expect(
      parseReviewOpenResponse({
        sessionId: descriptor.sessionId,
        url: descriptor.sessionUrl,
      }),
    ).toEqual({
      sessionId: descriptor.sessionId,
      url: descriptor.sessionUrl,
    });
    expect(
      parseReviewSessionLifecycleEvent({
        event: "dismissed",
        sessionId: "session-1",
        reason: "replaced",
      }),
    ).toEqual({
      event: "dismissed",
      sessionId: "session-1",
      reason: "replaced",
    });
    expect(
      parseReviewDesktopVerbFrame({
        event: "desktop-verb",
        id: "verb-1",
        sessionId: "session-1",
        request: { name: "focusCanvas", args: {} },
      }),
    ).toMatchObject({ id: "verb-1", sessionId: "session-1" });
    expect(
      parseReviewDesktopVerbResult({
        id: "verb-1",
        sessionId: "session-1",
        response: { ok: true },
      }),
    ).toEqual({ id: "verb-1", sessionId: "session-1", response: { ok: true } });
  });

  it("normalizes and validates the injected runtime config", () => {
    expect(
      parseReviewRuntimeConfig({
        serverUrl: "http://127.0.0.1:5570/ignored",
        sessionUrl: "http://127.0.0.1:5570/sessions/session-12",
        routePath: "pr/12/",
        sessionId: "session-12",
        token: "",
        wasmUrl: "vscode-webview://review/libavoid.wasm",
        docRuntimeUrl: "vscode-file://review/doc-runtime.js",
        appVersion: "0.0.13",
        theme: "dark",
        host: "desktop",
      }),
    ).toEqual({
      serverUrl: "http://127.0.0.1:5570",
      sessionUrl: "http://127.0.0.1:5570/sessions/session-12",
      routePath: "/pr/12",
      sessionId: "session-12",
      token: "",
      wasmUrl: "vscode-webview://review/libavoid.wasm",
      docRuntimeUrl: "vscode-file://review/doc-runtime.js",
      appVersion: "0.0.13",
      theme: "dark",
      host: "desktop",
    });
    expect(() =>
      parseReviewRuntimeConfig({
        serverUrl: "http://localhost:5570",
        sessionUrl: "http://127.0.0.1:5570/sessions/session",
        routePath: "/",
        sessionId: "session",
        token: "",
        wasmUrl: "http://localhost/wasm",
        docRuntimeUrl: "vscode-file://review/doc-runtime.js",
        appVersion: "0.0.13",
        theme: "dark",
        host: "desktop",
      }),
    ).toThrow("127.0.0.1");
  });

  it("parses event and one-based range verb boundaries", () => {
    expect(
      parseReviewServerEvent({
        event: "submitted",
        submissionId: "submission-12",
        decision: "approve",
      }),
    ).toEqual({
      event: "submitted",
      submissionId: "submission-12",
      decision: "approve",
    });
    expect(
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 10,
          endLine: 12,
          side: "base",
          highlight: true,
          preserveFocus: true,
        },
      }),
    ).toEqual({
      name: "reveal",
      args: {
        path: "src/cli.ts",
        startLine: 10,
        endLine: 12,
        side: "base",
        highlight: true,
        preserveFocus: true,
      },
    });
    expect(
      parseReviewVerbRequest({
        name: "reveal",
        args: { path: "src/legacy.ts", startLine: 1, endLine: 1 },
      }),
    ).toEqual({
      name: "reveal",
      args: { path: "src/legacy.ts", startLine: 1, endLine: 1 },
    });
    expect(() =>
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 1,
          endLine: 1,
          side: "working",
        },
      }),
    ).toThrow("args.side");
    expect(() =>
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 0,
          endLine: 1,
        },
      }),
    ).toThrow("positive integer");
  });

  it("parses file lists and file content variants", () => {
    expect(
      parseReviewFileContentRequest({ path: "src/new.ts", side: "base" }),
    ).toEqual({ path: "src/new.ts", side: "base" });
    expect(
      parseReviewDiffFilesResponse({
        ok: true,
        baseRef: "main",
        files: [
          {
            path: "src/new.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ],
      }),
    ).toMatchObject({ ok: true, files: [{ status: "renamed" }] });
    expect(
      parseReviewFileContentResponse({
        ok: true,
        content: "partial",
        truncated: true,
      }),
    ).toEqual({ ok: true, content: "partial", truncated: true });
    expect(parseReviewFileContentResponse({ ok: true, absent: true })).toEqual({
      ok: true,
      absent: true,
    });
    expect(parseReviewFileContentResponse({ ok: true, binary: true })).toEqual({
      ok: true,
      binary: true,
    });
  });

  it("parses surface events and one-based desktop state", () => {
    expect(
      parseReviewSurfaceEvent({
        event: "activeEditorChanged",
        path: "src/cli.ts",
      }),
    ).toEqual({ event: "activeEditorChanged", path: "src/cli.ts" });
    expect(
      parseReviewDesktopState({
        openEditors: [{ path: "src/cli.ts", scheme: "file" }],
        activeEditor: { path: "src/cli.ts", scheme: "file" },
        selection: {
          path: "src/cli.ts",
          startLine: 10,
          startColumn: 2,
          endLine: 12,
          endColumn: 4,
        },
      }),
    ).toMatchObject({ selection: { startLine: 10, endLine: 12 } });
  });

  it("parses thread decoration verbs at the one-based boundary", () => {
    expect(
      parseReviewVerbRequest({
        name: "decorateThreads",
        args: {
          sessionId: "session-a",
          path: "src/cli.ts",
          anchors: [
            {
              startLine: 10,
              endLine: 12,
              threadId: "code:src/cli.ts:10-12",
              kind: "comment",
            },
          ],
        },
      }),
    ).toMatchObject({
      name: "decorateThreads",
      args: {
        sessionId: "session-a",
        path: "src/cli.ts",
        anchors: [{ startLine: 10, endLine: 12 }],
      },
    });
    expect(
      parseReviewVerbRequest({
        name: "clearDecorations",
        args: { sessionId: "session-a", path: "src/cli.ts" },
      }),
    ).toEqual({
      name: "clearDecorations",
      args: { sessionId: "session-a", path: "src/cli.ts" },
    });
    expect(
      parseReviewVerbRequest({
        name: "decorateThreads",
        args: { path: "src/legacy.ts", anchors: [] },
      }),
    ).toEqual({
      name: "decorateThreads",
      args: { path: "src/legacy.ts", anchors: [] },
    });
    expect(
      parseReviewVerbRequest({
        name: "clearDecorations",
        args: { path: "src/legacy.ts" },
      }),
    ).toEqual({
      name: "clearDecorations",
      args: { path: "src/legacy.ts" },
    });
    expect(() =>
      parseReviewVerbRequest({
        name: "decorateThreads",
        args: {
          path: "src/cli.ts",
          anchors: [
            {
              startLine: 12,
              endLine: 10,
              threadId: "invalid",
              kind: "comment",
            },
          ],
        },
      }),
    ).toThrow("must be >=");
  });

  it("parses grouped server thread anchors", () => {
    expect(
      parseReviewThreadAnchorsResponse({
        ok: true,
        files: [
          {
            path: "src/review.ts",
            anchors: [
              {
                startLine: 4,
                endLine: 6,
                threadId: "code:head:src/review.ts:L4-L6",
                kind: "comment",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      files: [{ path: "src/review.ts", anchors: [{ startLine: 4 }] }],
    });
  });

  it("parses open-file options at the one-based boundary", () => {
    expect(
      parseReviewVerbRequest({
        name: "openFile",
        args: {
          path: "src/cli.ts",
          line: 10,
          column: 2,
          endLine: 12,
          preserveFocus: true,
        },
      }),
    ).toMatchObject({ name: "openFile", args: { line: 10, endLine: 12 } });
    expect(() =>
      parseReviewVerbRequest({
        name: "openFile",
        args: { path: "src/cli.ts", line: 10, endLine: 9 },
      }),
    ).toThrow("must be >=");
  });

  it("preserves the resolved base commit on the session boundary", () => {
    expect(
      parseReviewSession({
        rootPath: "/tmp/repo",
        baseRef: "main",
        appUrl: "http://127.0.0.1:5570/",
        reviewPath: "/tmp/review-session/review.mdx",
        resolvedBaseRef: "base-commit",
        startedAt: 1,
      }),
    ).toMatchObject({
      resolvedBaseRef: "base-commit",
    });
  });

  it("preserves server discovery fields on the session boundary", () => {
    expect(
      parseReviewSession({
        rootPath: "/tmp/repo",
        baseRef: "main",
        appUrl: "http://127.0.0.1:5570/",
        appPort: 5570,
        serverUrl: "http://127.0.0.1:5570/path",
        storageDir: "/tmp/review-session",
        reviewPath: "/tmp/review-session/review.mdx",
        startedAt: 1,
      }),
    ).toMatchObject({
      serverUrl: "http://127.0.0.1:5570",
      storageDir: "/tmp/review-session",
    });
  });

  it("parses the authenticated session response", () => {
    expect(
      parseReviewSessionResponse({
        ok: true,
        token: "capability-token",
        session: {
          sessionId: "session-1",
          rootPath: "/tmp/repo",
          baseRef: "main",
          appUrl: "http://127.0.0.1:5570/",
          serverUrl: "http://127.0.0.1:5570",
          storageDir: "/tmp/review-session",
          reviewPath: "/tmp/review-session/review.mdx",
          startedAt: 1,
        },
      }),
    ).toMatchObject({
      ok: true,
      token: "capability-token",
      session: { sessionId: "session-1" },
    });
  });

  it("normalizes route paths independently", () => {
    expect(normalizeReviewRoutePath("pr/9/?view=map")).toBe("/pr/9");
    expect(normalizeReviewRoutePath("/")).toBe("/");
  });
});
