import { describe, expect, it, vi } from "vitest";

import { reviewCommentPromptPrefix } from "../review-comment-agent";
import type { ReviewThreadsService } from "../review-threads-service";
import { NativeMessageMirror } from "./native-message-mirror";

describe("NativeMessageMirror OpenCode failures", () => {
  it("writes one agent failure message so pending activity clears", async () => {
    const threadId = "thread-1";
    const binding = { harness: "opencode" as const, sessionId: "session-1" };
    const thread = {
      threadId,
      target: { kind: "document" as const },
      status: "open" as const,
      agentSession: binding,
      messages: [
        {
          id: "question-1",
          by: "Reviewer",
          at: "2026-08-27T00:00:00.000Z",
          body: "Why?",
          agentInput: true,
        },
      ],
    };
    const upsertAgentSessionMessage =
      vi.fn<ReviewThreadsService["upsertAgentSessionMessage"]>();
    const service = {
      snapshot: () => ({
        revision: 0,
        comments: {},
        drafts: { [threadId]: { thread } },
      }),
      upsertAgentSessionMessage,
    } as unknown as ReviewThreadsService;
    const mirror = new NativeMessageMirror({
      service,
      observe: () => ({
        ref: binding,
        updates: async () => ({
          snapshot: {
            session: binding,
            messages: [
              {
                id: "session-1:user-1:text-1",
                role: "user",
                body: `${reviewCommentPromptPrefix(threadId)}Why?`,
                createdAt: "2026-08-27T00:00:00.000Z",
              },
            ],
            failures: [
              {
                id: "session-1:historical:error",
                error: "old failure",
                createdAt: "2026-08-26T00:00:00.000Z",
              },
              {
                id: "session-1:assistant-1:error",
                error: "provider unavailable",
                createdAt: "2026-08-27T00:00:01.000Z",
              },
            ],
          },
          updates: { async *[Symbol.asyncIterator]() {} },
          close: async () => undefined,
        }),
      }),
    });

    mirror.watch(threadId, binding);
    await vi.waitFor(() =>
      expect(upsertAgentSessionMessage).toHaveBeenCalledTimes(2),
    );

    expect(upsertAgentSessionMessage).toHaveBeenLastCalledWith({
      mutationId: expect.any(String),
      threadId,
      messageId: "session-1:assistant-1:error",
      role: "agent",
      author: "OpenCode",
      body: "OpenCode failed: provider unavailable",
      createdAt: "2026-08-27T00:00:01.000Z",
      agentInput: false,
    });
    await mirror.close();
  });

  it.each(["claude-code", "codex", "opencode", "pi"] as const)(
    "does not synthesize observer failures for %s",
    async (harness) => {
      const threadId = "thread-1";
      const binding = { harness, sessionId: "session-1" };
      const upsertAgentSessionMessage =
        vi.fn<ReviewThreadsService["upsertAgentSessionMessage"]>();
      const onError = vi.fn<(error: unknown) => void>();
      const service = {
        snapshot: () => ({
          revision: 0,
          comments: {
            [threadId]: {
              threadId,
              target: { kind: "document" as const },
              status: "open" as const,
              agentSession: binding,
              messages: [],
            },
          },
          drafts: {},
        }),
        upsertAgentSessionMessage,
      } as unknown as ReviewThreadsService;
      const mirror = new NativeMessageMirror({
        service,
        onError,
        observe: () => ({
          ref: binding,
          updates: async () => {
            throw new Error("observer unavailable");
          },
        }),
      });

      mirror.watch(threadId, binding);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

      expect(upsertAgentSessionMessage).not.toHaveBeenCalled();
      await mirror.close();
    },
  );
});
