import type {
  WhiteboardCanvasBridge,
  WhiteboardRuntimeConfig,
} from "@dev.fast/whiteboard-protocol";
import type { ReactNode } from "react";

import type { Block } from "../../src/session-api/document";
import type { ApiDocumentData } from "./api-document";
import { apiHeadingIds } from "./api-document-headings";
import { whiteboardFetchUrl } from "./host/whiteboard-client";
import {
  type WhiteboardSession,
  WhiteboardSessionProvider,
  createWhiteboardSession,
} from "./host/whiteboard-session";

export const TEST_WHITEBOARD_CONFIG = {
  serverUrl: "http://127.0.0.1:5570",
  sessionId: "test-session",
  token: "secret-token",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies WhiteboardRuntimeConfig;

export function testWhiteboardBridge(
  config: Partial<WhiteboardRuntimeConfig> = {},
  overrides: Partial<Omit<WhiteboardCanvasBridge, "config">> = {},
): WhiteboardCanvasBridge {
  return {
    config: { ...TEST_WHITEBOARD_CONFIG, ...config },
    diffView: {
      files: async () => [],
      create: () => {
        throw new Error("unused test diff view");
      },
    },
    inlineEditors: {
      async find() {
        return { matchCount: 0 };
      },
      create: () => {
        throw new Error("unused test inline editor");
      },
    },
    request: (url, init) => whiteboardFetchUrl({}, url, init),
    post: async () => ({ ok: true }),
    subscribe: () => ({ dispose() {} }),
    currentTheme: () => "dark",
    onDidChangeTheme: () => ({ dispose() {} }),
    currentDiffLayout: () => "split",
    async setDiffLayout() {},
    onDidChangeDiffLayout: () => ({ dispose() {} }),
    ready() {},
    ...overrides,
  };
}

export function testWhiteboardSession(
  config: Partial<WhiteboardRuntimeConfig> = {},
  bridge: Partial<Omit<WhiteboardCanvasBridge, "config">> = {},
): WhiteboardSession {
  return {
    ...createWhiteboardSession(testWhiteboardBridge(config, bridge), {
      jsonWhiteboard: {
        id: config.sessionId ?? "test-review",
        version: () => undefined,
      },
    }),
    review: {
      pins: { base: "a".repeat(40), head: "b".repeat(40) },
      historicalRevision: null,
      updatedAtMs: Date.now(),
      traces: new Map(),
      listVersions: async () => [],
      stack: async () => [],
      dismiss: async () => {},
    },
  };
}

/** Document data for `blocks` alone, with empty resource maps. */
export function testApiDocumentData(blocks: Block[]): ApiDocumentData {
  return {
    snapshot: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      version: 1,
      title: "Imported",
      pins: { repositoryId: "repo", base: "base", head: "head" },
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      document: blocks,
    },
    headings: apiHeadingIds(blocks),
    commits: [],
    anchors: new Map(),
    images: new Map(),
    traces: new Map(),
    maps: new Map(),
  };
}

// Test files that are plain .ts cannot write JSX, and passing `children`
// through createElement's props trips react/no-children-prop.
export function whiteboardSessionElement(
  session: WhiteboardSession,
  children: ReactNode,
) {
  return (
    <WhiteboardSessionProvider session={session}>
      {children}
    </WhiteboardSessionProvider>
  );
}
