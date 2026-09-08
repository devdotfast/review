import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { AsyncQueue } from "../native-agent/async-queue";
import { NativeMessageMirror } from "../native-agent/native-message-mirror";
import type {
  AgentServer,
  NativeReviewMessage,
  SessionUpdate,
} from "../native-agent/native-session";
import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { ReviewThreadsService } from "../review-threads-service";
import { answerReviewComment } from "./review-api";

it("persists acceptance before opening the terminal, reopens on retry, and keeps the original boundary for follow-ups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-question-"));
  const service = new ReviewThreadsService({
    reviewPath: path.join(dir, "review.mdx"),
    author: "Reviewer",
  });
  const comment = {
    threadId: "question",
    messageId: "local-ask",
    target: { kind: "document" as const },
    body: "Explain this",
  };
  service.dispatch({
    command: "comment-draft.create",
    mutationId: "create",
    input: comment,
  });
  const nativeMessages: NativeReviewMessage[] = [];
  let promptCount = 0;
  const bindingsDuringSubmission: unknown[] = [];
  const server: AgentServer = {
    harness: "codex",
    launch: async (input) => {
      if (input.prompt) {
        await input.prompt.prepared("fork");
        bindingsDuringSubmission.push(
          service.snapshot().drafts.question?.thread.agentSession,
        );
        promptCount += 1;
        const messageId = `native-${promptCount}`;
        nativeMessages.push({
          id: messageId,
          role: "user",
          body: input.prompt.text,
          createdAt: "2026-09-07T00:00:00Z",
        });
        await input.prompt.accepted("fork", messageId);
      }
      return {
        sessionId: "fork",
        command: { executable: "codex", args: [], env: {}, cwd: dir },
      };
    },
    updates: async () => {
      const updates = new AsyncQueue<SessionUpdate>();
      return {
        snapshot: { sessionId: "fork", messages: [...nativeMessages] },
        updates,
        close: async () => updates.close(),
      };
    },
    close: async () => {},
  };
  const makeMirror = () =>
    new NativeMessageMirror({ service, updates: () => server.updates("fork") });
  let mirror = makeMirror();
  const openTerminal = vi.fn<
    NonNullable<
      Parameters<typeof answerReviewComment>[0]["openNativeAgentTerminal"]
    >
  >(async () => {});
  const input = () => ({
    comment,
    rootPath: dir,
    service,
    mirror,
    session: { agent: { harness: "codex" as const, sessionId: "author" } },
    agentServer: () => server,
    openNativeAgentTerminal: openTerminal,
  });
  try {
    openTerminal.mockRejectedValueOnce(new Error("terminal failed"));
    await expect(answerReviewComment(input())).rejects.toThrow(
      "terminal failed",
    );
    expect(service.snapshot().drafts.question?.thread).toMatchObject({
      agentSession: { firstMessageId: "native-1" },
      messages: [
        {
          id: "local-ask",
          body: "Explain this",
          agentMessage: { sessionId: "fork", messageId: "native-1" },
        },
      ],
    });
    await mirror.close();
    mirror = makeMirror();
    await answerReviewComment(input());
    expect(promptCount).toBe(1);
    expect(bindingsDuringSubmission).toEqual([undefined]);
    expect(openTerminal).toHaveBeenCalledTimes(2);

    const followup = {
      ...comment,
      messageId: "local-followup",
      body: "Explain this",
    };
    service.dispatch({
      command: "comment-draft.create",
      mutationId: "followup",
      input: followup,
    });
    await answerReviewComment({ ...input(), comment: followup });
    expect(promptCount).toBe(2);
    expect(service.snapshot().drafts.question?.thread).toMatchObject({
      agentSession: { firstMessageId: "native-1" },
      messages: [
        {
          id: "local-ask",
          body: "Explain this",
          agentMessage: { messageId: "native-1" },
        },
        {
          id: "local-followup",
          body: "Explain this",
          agentMessage: { messageId: "native-2" },
        },
      ],
    });
    await mirror.close();
    expect(service.snapshot().drafts.question?.thread.messages).toHaveLength(2);
  } finally {
    await mirror.close();
    closeAllReviewThreadStores();
    await rm(dir, { recursive: true, force: true });
  }
});
