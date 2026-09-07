import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { reviewCommentPromptPrefix } from "../review-comment-agent";
import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { ReviewThreadsService } from "../review-threads-service";
import { AsyncQueue } from "./async-queue";
import { NativeMessageMirror } from "./native-message-mirror";
import type { NativeReviewMessage, SessionUpdate } from "./native-session";

it.each(["codex", "opencode", "pi", "claude-code"] as const)(
  "%s mirrors only the comment conversation, including after reconnect",
  async (harness) => {
    const directory = await mkdtemp(path.join(tmpdir(), "review-mirror-"));
    const service = new ReviewThreadsService({
      reviewPath: path.join(directory, "review.mdx"),
      author: "Reviewer",
    });
    const binding = { harness, sessionId: "fork" };
    const threadId = "question";
    service.dispatch({
      command: "comment.create",
      mutationId: "create",
      input: {
        threadId,
        messageId: "question-message",
        target: { kind: "document" },
        body: "Explain this",
      },
    });
    service.setAgentSession({ mutationId: "bind", threadId, agentSession: binding });
    const message = (role: NativeReviewMessage["role"], body: string): NativeReviewMessage => ({
      role, body, createdAt: "2026-09-07T00:00:00.000Z",
    });
    const history = [
      message("user", "Original task"),
      message("assistant", "Original answer"),
      message("user", reviewCommentPromptPrefix("another-thread") + "Another question"),
      message("assistant", "Another answer"),
      message("user", reviewCommentPromptPrefix(threadId) + "Explain this"),
      message("assistant", "This comment's answer"),
    ];
    const makeMirror = () => new NativeMessageMirror({
      service,
      updates: async () => {
        const updates = new AsyncQueue<SessionUpdate>();
        updates.close();
        return {
          snapshot: { sessionId: binding.sessionId, messages: history },
          updates,
          close: async () => updates.close(),
        };
      },
    });
    try {
      for (let connection = 0; connection < 2; connection += 1) {
        const mirror = makeMirror();
        mirror.start();
        try {
          await expect.poll(() => service.snapshot().comments[threadId]?.messages.map(m => m.body))
            .toEqual(["Explain this", "This comment's answer"]);
        } finally {
          await mirror.close();
        }
      }
    } finally {
      closeAllReviewThreadStores();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
