import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewCommentAgentSession } from "@dev.fast/review-protocol";
import { afterEach, expect, it } from "vitest";

import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { ReviewThreadsService } from "../review-threads-service";
import { AsyncQueue } from "./async-queue";
import { NativeMessageMirror } from "./native-message-mirror";
import type { NativeReviewMessage, SessionUpdate } from "./native-session";

const directories: string[] = [];
const mirrors: NativeMessageMirror[] = [];
afterEach(async () => {
  await Promise.all(mirrors.splice(0).map((mirror) => mirror.close()));
  closeAllReviewThreadStores();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function thread(binding: ReviewCommentAgentSession) {
  const directory = await mkdtemp(path.join(tmpdir(), "review-mirror-"));
  directories.push(directory);
  const service = new ReviewThreadsService({
    reviewPath: path.join(directory, "review.mdx"),
    author: "Reviewer",
  });
  service.dispatch({
    command: "comment.create",
    mutationId: "create",
    input: {
      threadId: "question",
      messageId: "local-question",
      target: { kind: "document" },
      body: "Explain this",
    },
  });
  service.setAgentSession({
    mutationId: "bind",
    threadId: "question",
    agentSession: binding,
  });
  service.upsertAgentSessionMessage({
    mutationId: "accept",
    threadId: "question",
    messageId: "local-question",
    role: "reviewer",
    body: "Explain this",
    agentInput: true,
    agentMessage: {
      sessionId: binding.sessionId,
      messageId: binding.firstMessageId,
    },
  });
  return service;
}

const message = (
  id: string,
  role: NativeReviewMessage["role"],
  body: string,
): NativeReviewMessage => ({
  id,
  role,
  body,
  createdAt: "2026-09-07T00:00:00.000Z",
});

function connect(
  service: ReviewThreadsService,
  history: NativeReviewMessage[],
) {
  const updates = new AsyncQueue<SessionUpdate>();
  const mirror = new NativeMessageMirror({
    service,
    updates: async () => ({
      snapshot: { sessionId: "fork", messages: history },
      updates,
      close: async () => updates.close(),
    }),
  });
  mirrors.push(mirror);
  mirror.start();
  return { mirror, updates };
}

it("ignores inherited prompts, preserves identical replies, and deduplicates on reconnect by ID", async () => {
  const service = await thread({
    harness: "codex",
    sessionId: "fork",
    firstMessageId: "ask",
  });
  const history = [
    // Even an inherited Ask for this exact comment cannot open the boundary.
    message("old-ask", "user", "dev-review-thread-id: question\nExplain this"),
    message("old-answer", "assistant", "Inherited answer"),
    message("ask", "user", "Instructions plus the submitted question"),
    message("answer-1", "assistant", "Same answer"),
    message("followup", "user", "Explain this"),
    message("answer-2", "assistant", "Same answer"),
  ];
  for (let connection = 0; connection < 2; connection += 1) {
    const { mirror, updates } = connect(service, history);
    await expect
      .poll(() =>
        service.snapshot().comments.question?.messages.map((m) => m.body),
      )
      .toEqual(["Explain this", "Same answer", "Explain this", "Same answer"]);
    updates.push({
      type: "message.updated",
      message: message("answer-2", "assistant", "Revised answer"),
    });
    await expect
      .poll(() => service.snapshot().comments.question?.messages.at(-1)?.body)
      .toBe("Revised answer");
    expect(service.snapshot().comments.question?.messages).toHaveLength(4);
    await mirror.close();
  }
});

it("waits for the exact boundary when the native prompt has not materialized yet", async () => {
  const service = await thread({
    harness: "opencode",
    sessionId: "fork",
    firstMessageId: "ask",
  });
  const { updates } = connect(service, []);
  updates.push({
    type: "message.updated",
    message: message("old", "user", "Explain this"),
  });
  updates.push({
    type: "message.updated",
    message: message("ask", "user", "Full prompt"),
  });
  updates.push({
    type: "message.updated",
    message: message("answer", "assistant", "New answer"),
  });
  await expect
    .poll(() =>
      service.snapshot().comments.question?.messages.map((m) => m.body),
    )
    .toEqual(["Explain this", "New answer"]);
});
