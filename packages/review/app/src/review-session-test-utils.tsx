import type {
  ReviewCanvasBridge,
  ReviewRuntimeConfig,
} from "@dev.fast/review-protocol";
import type { ReactNode } from "react";

import { reviewFetchUrl } from "./host/review-client";
import {
  type ReviewSession,
  ReviewSessionProvider,
  createReviewSession,
} from "./host/review-session";

export const TEST_REVIEW_CONFIG = {
  serverUrl: "http://127.0.0.1:5570",
  reviewId: "test-session",
  token: "secret-token",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies ReviewRuntimeConfig;

export function testReviewBridge(
  config: Partial<ReviewRuntimeConfig> = {},
  overrides: Partial<Omit<ReviewCanvasBridge, "config">> = {},
): ReviewCanvasBridge {
  return {
    config: { ...TEST_REVIEW_CONFIG, ...config },
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
    request: (url, init) => reviewFetchUrl({}, url, init),
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

export function testReviewSession(
  config: Partial<ReviewRuntimeConfig> = {},
  bridge: Partial<Omit<ReviewCanvasBridge, "config">> = {},
): ReviewSession {
  return {
    ...createReviewSession(testReviewBridge(config, bridge), {
      jsonReview: {
        id: config.reviewId ?? "test-review",
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

// Test files that are plain .ts cannot write JSX, and passing `children`
// through createElement's props trips react/no-children-prop.
export function reviewSessionElement(
  session: ReviewSession,
  children: ReactNode,
) {
  return (
    <ReviewSessionProvider session={session}>{children}</ReviewSessionProvider>
  );
}
