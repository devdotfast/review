import { randomUUID } from "node:crypto";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { AsyncQueue } from "../native-agent/async-queue.js";
import type {
  AgentServer,
  SessionUpdate,
} from "../native-agent/native-session.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { answerWithAgent } from "./question-agent.js";
import { type QuestionExecution, ReviewQuestions } from "./questions.js";
import { ReviewStore } from "./store.js";

const store = new ReviewStore(":memory:", {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
});

const repository = store.registerRepository("/source");

const command = <Operation>(operation: Operation) =>
  store.execute({ commandId: randomUUID(), operation });

let questions: ReviewQuestions;

afterEach(() => questions?.close());

afterAll(() => store.close());

it("accepts Ask promptly, uses the saved question/version, and saves a single immutable answer across retries", async () => {
  const { reviewId } = await command({
    type: "create",
    title: "Question",
    pins: { repositoryId: repository.id, base: "a", head: "b" },
  });

  await command({
    type: "feedback",
    reviewId,
    action: {
      type: "post",
      threadId: "ask-thread",
      messageId: "ask-message",
      version: 0,
      target: { kind: "document" },
      body: "Why does this exist?",
    },
  });
  let finish!: (answer: string) => void;

  const execute = vi.fn<(input: QuestionExecution) => Promise<string>>(
    (_input: QuestionExecution) =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );

  questions = new ReviewQuestions(store, execute);
  const api = createReviewApi(store, undefined, undefined, questions);

  const client = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => api.request(url.replace("/reviews-api", ""), init),
  );

  const input = { threadId: "ask-thread", messageId: "ask-message" };
  expect(await client.post(`/${reviewId}/ask`, input)).toEqual({
    status: "running",
  });
  expect(await client.post(`/${reviewId}/ask`, input)).toEqual({
    status: "running",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]![0]).toMatchObject({
    cwd: "/source",
    prompt: expect.stringContaining("Why does this exist?"),
  });
  finish("It keeps the desktop responsible for saving reviews.");
  await vi.waitFor(() =>
    expect(questions.read(reviewId, "ask-message")).toEqual({
      status: "completed",
    }),
  );
  expect(store.feedback.read(reviewId).threads[0]!.messages).toMatchObject([
    { by: "user", body: "Why does this exist?" },
    {
      by: "agent",
      version: 0,
      body: "It keeps the desktop responsible for saving reviews.",
    },
  ]);
  const execution = execute.mock.calls[0]![0];
  await execution.onFollowup({
    id: "terminal-question",
    by: "user",
    body: "And after restart?",
  });
  await execution.onFollowup({
    id: "terminal-answer",
    by: "agent",
    body: "The saved conversation remains.",
  });
  expect(
    store.feedback.read(reviewId).threads[0]!.messages.slice(-2),
  ).toMatchObject([
    { id: "terminal-question", by: "user", draft: false },
    { id: "terminal-answer", by: "agent", draft: false },
  ]);
  questions.close();
  questions = new ReviewQuestions(store, execute);
  expect(questions.start(reviewId, input)).toEqual({ status: "completed" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.read(reviewId).version).toBe(0);
});

it("answers every submitted thread after editing the review; failures can retry without discarding questions", async () => {
  const { reviewId } = await command({
    type: "create",
    title: "Feedback",
    pins: { repositoryId: repository.id, base: "a", head: "b" },
  });

  for (const id of ["one", "two"])
    await command({
      type: "feedback",
      reviewId,
      action: {
        type: "save",
        threadId: id,
        messageId: id,
        version: 0,
        target: { kind: "document" },
        body: `Explain ${id}`,
      },
    });
  await command({
    type: "feedback",
    reviewId,
    action: {
      type: "submit",
      version: 0,
      decision: "request-changes",
      messageIds: ["one", "two"],
    },
  });
  const submissionId = store.feedback.read(reviewId).submissions[0]!.id;

  const execute = vi.fn<(input: QuestionExecution) => Promise<string>>(
    async () => {
      await command({
        type: "edit",
        reviewId,
        edit: {
          type: "insert",
          content: { type: "markdown", markdown: "Both explanations." },
        },
      });

      return JSON.stringify({
        replies: [
          { threadId: "one", body: "Explained one." },
          { threadId: "two", body: "Explained two." },
        ],
      });
    },
  );

  execute.mockRejectedValueOnce(new Error("private process details"));
  questions = new ReviewQuestions(store, execute);
  questions.start(reviewId, { submissionId });
  await vi.waitFor(() =>
    expect(questions.read(reviewId, submissionId).status).toBe("failed"),
  );
  expect(questions.read(reviewId, submissionId).error).not.toContain(
    "private process",
  );
  expect(
    store.feedback
      .read(reviewId)
      .threads.every((thread) => thread.messages.length === 1),
  ).toBe(true);
  questions.start(reviewId, { submissionId });
  await vi.waitFor(() =>
    expect(questions.read(reviewId, submissionId).status).toBe("completed"),
  );
  expect(store.read(reviewId).document).toMatchObject([
    { markdown: "Both explanations." },
  ]);

  for (const thread of store.feedback.read(reviewId).threads)
    expect(thread.messages.at(-1)).toMatchObject({ by: "agent", version: 1 });
  expect(store.activity.read(reviewId).workingCount).toBe(0);
});

it("launches a fresh session, saves completed terminal follow-ups, and stops observing on shutdown", async () => {
  const queue = new AsyncQueue<SessionUpdate>();

  const close = vi.fn<() => Promise<void>>(async () => {
    queue.close();
  });

  const launch = vi.fn<AgentServer["launch"]>(async () => ({
    sessionId: "new-session",
    command: { executable: "agent", args: [], cwd: "/source", env: {} },
  }));

  const agent: AgentServer = {
    harness: "codex",
    launch,
    updates: async () => ({ updates: queue, close }),
    interrupt: vi.fn<AgentServer["interrupt"]>(async () => {}),
    close,
  };

  const open = vi.fn<() => Promise<void>>(async () => {
    queue.push({ type: "status.changed", status: "running" });
    queue.push({
      type: "message.updated",
      message: {
        id: "answer",
        role: "assistant",
        body: "Finished answer.",
        createdAt: "now",
      },
    });
    queue.push({ type: "status.changed", status: "idle" });
  });

  const abort = new AbortController();
  const onFollowup = vi.fn<() => Promise<void>>(async () => {});
  expect(
    await answerWithAgent(
      agent,
      {
        reviewId: "review",
        threadId: "thread",
        messageId: "question",
        prompt: "Question",
        cwd: "/source",
        signal: abort.signal,
        onFollowup,
        onError: vi.fn<QuestionExecution["onError"]>(),
      },
      open,
    ),
  ).toBe("Finished answer.");
  expect(launch).toHaveBeenCalledWith({
    cwd: "/source",
    prompt: { id: "question", text: "Question" },
  });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      reviewId: "review",
      session: { harness: "codex", sessionId: "new-session" },
    }),
  );
  expect(close).not.toHaveBeenCalled();
  queue.push({
    type: "message.updated",
    message: { id: "followup", role: "user", body: "Why?", createdAt: "now" },
  });
  queue.push({ type: "status.changed", status: "running" });
  queue.push({
    type: "message.updated",
    message: {
      id: "second-answer",
      role: "assistant",
      body: "Partial",
      createdAt: "now",
    },
  });
  queue.push({
    type: "message.updated",
    message: {
      id: "second-answer",
      role: "assistant",
      body: "Complete answer",
      createdAt: "now",
    },
  });
  queue.push({ type: "status.changed", status: "idle" });
  await vi.waitFor(() => expect(onFollowup).toHaveBeenCalledTimes(2));
  expect(onFollowup.mock.calls).toEqual([
    [{ id: "new-session:followup", by: "user", body: "Why?" }],
    [{ id: "new-session:second-answer", by: "agent", body: "Complete answer" }],
  ]);
  abort.abort();
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
});
