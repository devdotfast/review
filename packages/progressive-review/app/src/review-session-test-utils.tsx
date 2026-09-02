import type {
  ReviewCanvasBridge,
  ReviewCommentStoreBridge,
  ReviewCommentStoreChange,
  ReviewCommentStoreSnapshot,
  ReviewCommentThreadRecord,
  ReviewLocalCommentThread,
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
  sessionUrl: "http://127.0.0.1:5570/sessions/test-session",
  routePath: "/review.mdx",
  sessionId: "test-session",
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
    comments: createTestCommentStore(),
    diffView: {
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
    ready() {},
    ...overrides,
  };
}

function createTestCommentStore(): ReviewCommentStoreBridge {
  const listeners = new Set<(change: ReviewCommentStoreChange) => void>();
  const persisted = new Map<string, ReviewCommentThreadRecord>();
  const local = new Map<string, ReviewLocalCommentThread>();
  let snapshot = buildSnapshot();

  function buildSnapshot(): ReviewCommentStoreSnapshot {
    const commentThreads = new Map(persisted);
    for (const [threadId, comment] of local) {
      commentThreads.set(threadId, comment.thread);
    }
    return {
      commentThreads,
      localComments: new Map(local),
      agentActivities: new Map(),
      pendingCommentCount: local.size,
    };
  }

  function publish(): void {
    const previous = snapshot;
    snapshot = buildSnapshot();
    const threadIds = new Set([
      ...previous.commentThreads.keys(),
      ...snapshot.commentThreads.keys(),
    ]);
    for (const listener of listeners) listener({ threadIds });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    async saveComment(input) {
      const existing = local.get(input.threadId)?.thread;
      const message = {
        id: input.messageId,
        by: "You",
        at: "2026-01-01T00:00:00.000Z",
        body: input.body.trim(),
        agentInput: input.agentInput ?? false,
      };
      local.set(input.threadId, {
        clientStatus: "draft",
        thread: existing
          ? { ...existing, messages: [...existing.messages, message] }
          : {
              threadId: input.threadId,
              target: input.target,
              status: "open",
              messages: [message],
            },
        inputs: [...(local.get(input.threadId)?.inputs ?? []), input],
      });
      publish();
    },
    async askAgent(input) {
      await this.saveComment(input);
    },
    async deleteLocalComment(threadId) {
      local.delete(threadId);
      publish();
    },
    async updateComment(threadId, body, messageId) {
      const comment = local.get(threadId);
      if (!comment) return;
      const index = messageId
        ? comment.thread.messages.findIndex(
            (message) => message.id === messageId,
          )
        : comment.thread.messages.length - 1;
      local.set(threadId, {
        ...comment,
        thread: {
          ...comment.thread,
          messages: comment.thread.messages.map((message, messageIndex) =>
            messageIndex === index ? { ...message, body } : message,
          ),
        },
      });
      publish();
    },
    async deleteComment(threadId) {
      local.delete(threadId);
      persisted.delete(threadId);
      publish();
    },
    async deleteCommentMessage(threadId, messageId) {
      const comment = local.get(threadId);
      if (!comment) return;
      const messages = comment.thread.messages.filter(
        (message) => message.id !== messageId,
      );
      if (messages.length === 0) local.delete(threadId);
      else {
        local.set(threadId, {
          ...comment,
          thread: { ...comment.thread, messages },
          inputs: comment.inputs.filter(
            (input) => input.messageId !== messageId,
          ),
        });
      }
      publish();
    },
    async setCommentResolved(threadId, resolved) {
      const comment = local.get(threadId);
      if (!comment) return;
      local.set(threadId, {
        ...comment,
        thread: {
          ...comment.thread,
          status: resolved ? "resolved" : "open",
        },
      });
      publish();
    },
    async flushPendingComments() {
      const inputs = [...local.values()].flatMap((comment) => comment.inputs);
      for (const [threadId, comment] of local) {
        local.set(threadId, { ...comment, clientStatus: "submitting" });
      }
      publish();
      return inputs;
    },
    async persistComment() {
      return;
    },
    resetPendingComments() {
      for (const [threadId, comment] of local) {
        if (comment.clientStatus === "submitting") {
          local.set(threadId, { ...comment, clientStatus: "draft" });
        }
      }
      publish();
    },
    completeHumanReviewRound() {
      for (const [threadId, comment] of local) {
        persisted.set(threadId, comment.thread);
      }
      local.clear();
      publish();
    },
  };
}

export function testReviewSession(
  config: Partial<ReviewRuntimeConfig> = {},
  bridge: Partial<Omit<ReviewCanvasBridge, "config">> = {},
): ReviewSession {
  return createReviewSession(testReviewBridge(config, bridge));
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

export function TestReviewSessionProvider({
  session = testReviewSession(),
  children,
}: {
  session?: ReviewSession;
  children: ReactNode;
}) {
  return (
    <ReviewSessionProvider session={session}>{children}</ReviewSessionProvider>
  );
}
