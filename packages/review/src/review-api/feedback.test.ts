import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ReviewApiClient } from "./client.js";
import { ReviewInputError } from "./document.js";
import type { FeedbackSnapshot } from "./feedback.js";
import { createReviewApi } from "./http.js";
import { ReviewStore } from "./store.js";

let directory: string, database: string, store: ReviewStore, reviewId: string;

const pins = {
  repositoryId: "repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
};

const providers = {
  validatePins: vi.fn<() => Promise<void>>(async () => {}),
  validateSource: vi.fn<() => Promise<void>>(async () => {}),
  validateResource: vi.fn<() => Promise<void>>(async () => {}),
};

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const feedback = async <Action>(action: Action, id = reviewId) =>
  store.execute(command({ type: "feedback", reviewId: id, action }));

const question = {
  threadId: "thread-1",
  messageId: "message-1",
  version: 0,
  target: { kind: "document" },
  body: "Why does this change the API?",
};

beforeEach(async () => {
  vi.resetAllMocks();
  directory = mkdtempSync(path.join(tmpdir(), "review-feedback-"));
  database = path.join(directory, "review.db");
  store = new ReviewStore(database, providers);
  ({ reviewId } = await store.execute(
    command({ type: "create", title: "Feedback", pins }),
  ));
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

it("saves explicit drafts, submits them atomically, and keeps posted questions and answers immutable", async () => {
  await expect(
    feedback({ type: "save", ...question, body: "  " }),
  ).rejects.toThrow(Error);
  expect(store.feedback.read(reviewId).threads).toEqual([]);
  await expect(
    feedback({
      type: "save",
      threadId: "new",
      messageId: "new-message",
      version: 0,
      body: "Where?",
    }),
  ).rejects.toThrow(/need a comment target/);
  await feedback({ type: "save", ...question });
  await feedback({
    type: "edit-draft",
    threadId: question.threadId,
    messageId: question.messageId,
    body: "Please explain the API change.",
  });

  const submit = command({
    type: "feedback",
    reviewId,
    action: {
      type: "submit",
      version: 0,
      decision: "request-changes",
      messageIds: [question.messageId],
    },
  });

  const result = await store.execute(submit);
  expect(await store.execute(submit)).toEqual(result);
  await feedback({
    type: "reply",
    threadId: question.threadId,
    messageId: "answer",
    version: 0,
    by: "agent",
    body: "The desktop now owns storage.",
  });
  const saved = store.feedback.read(reviewId);
  expect(
    saved.threads[0]!.messages.map((message) => [
      message.body,
      message.by,
      message.draft,
    ]),
  ).toEqual([
    ["Please explain the API change.", "user", false],
    ["The desktop now owns storage.", "agent", false],
  ]);
  expect(saved.submissions).toHaveLength(1);
  expect(saved.submissions[0]).toMatchObject({
    id: result.targetId,
    version: 0,
    decision: "request-changes",
    messageIds: [question.messageId],
  });
  await expect(
    feedback({
      type: "edit-draft",
      threadId: question.threadId,
      messageId: question.messageId,
      body: "Overwrite",
    }),
  ).rejects.toThrow(/cannot be edited/);
  await expect(
    feedback({
      type: "discard-draft",
      threadId: question.threadId,
      messageId: "answer",
    }),
  ).rejects.toThrow(/cannot be deleted/);
  expect(store.history(reviewId)).toHaveLength(1);
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.feedback.read(reviewId)).toEqual(saved);
});

it("retains original comment context through repin and restore, with new replies tied to their own versions", async () => {
  await feedback({ type: "post", ...question });
  await store.execute(
    command({
      type: "repin",
      reviewId,
      pins: { ...pins, head: "c".repeat(40) },
    }),
  );
  await feedback({
    type: "reply",
    threadId: question.threadId,
    messageId: "follow-up",
    version: 1,
    by: "user",
    body: "What about the new head?",
  });
  await feedback({
    type: "resolve",
    threadId: question.threadId,
    resolved: true,
  });
  const before = store.feedback.read(reviewId);
  await store.execute(command({ type: "restore", reviewId, version: 0 }));
  expect(store.read(reviewId).pins).toEqual(pins);
  expect(store.feedback.read(reviewId)).toMatchObject({
    threads: before.threads,
    submissions: before.submissions,
  });
  expect(before.threads[0]).toMatchObject({
    version: 0,
    resolved: true,
    target: { kind: "document" },
  });
  expect(before.threads[0]!.messages.map((message) => message.version)).toEqual(
    [0, 1],
  );
});

it("rejects a stale batch without posting any drafts and isolates reviews in the shared database", async () => {
  const other = await store.execute(
    command({ type: "create", title: "Other", pins }),
  );

  await Promise.all([
    feedback({ type: "save", ...question }),
    feedback({ type: "save", ...question }, other.reviewId),
  ]);
  await expect(
    feedback({
      type: "submit",
      version: 0,
      decision: "request-changes",
      messageIds: [question.messageId, "missing"],
    }),
  ).rejects.toThrow(/no longer exists/);
  expect(store.feedback.read(reviewId).submissions).toEqual([]);
  expect(store.feedback.read(reviewId).threads[0]!.messages[0]!.draft).toBe(
    true,
  );
  await feedback({ type: "discard-draft", threadId: question.threadId });
  expect(store.feedback.read(reviewId).threads).toEqual([]);
  expect(store.feedback.read(other.reviewId).threads).toHaveLength(1);
  await expect(
    feedback({ type: "post", ...question, version: 99 }),
  ).rejects.toThrow(/not found/);
});

it("checks code selections against pinned source before saving a thread", async () => {
  const position = createGitLabTextDiffPosition({
    base_sha: pins.base,
    start_sha: pins.base,
    head_sha: pins.head,
    old_path: "old.ts",
    new_path: "new.ts",
    start: { old_line: null, new_line: 5 },
    end: { old_line: null, new_line: 6 },
  });

  const input = {
    type: "post",
    ...question,
    target: { kind: "code", position, original_position: position },
  };

  providers.validateSource.mockRejectedValueOnce(
    new ReviewInputError("Source range exceeds the pinned file."),
  );
  await expect(feedback(input)).rejects.toThrow(/exceeds/);
  expect(store.feedback.read(reviewId).threads).toEqual([]);
  await feedback(input);
  expect(providers.validateSource).toHaveBeenLastCalledWith(pins, {
    side: "head",
    file: "new.ts",
    fromLine: 5,
    toLine: 6,
  });
});

it("streams current feedback to multiple clients and on reconnect without publishing a new document", async () => {
  const app = new Hono().route("/reviews-api", createReviewApi(store));

  const client = new ReviewApiClient(
    { serverUrl: "http://localhost", token: "test" },
    async (url, init) => app.request(url, init),
  );

  const abort = new AbortController();

  const first = client.watch<FeedbackSnapshot>(
    reviewId,
    abort.signal,
    "feedback",
  );

  const second = client.watch<FeedbackSnapshot>(
    reviewId,
    abort.signal,
    "feedback",
  );

  expect((await first.next()).value?.threads).toEqual([]);
  expect((await second.next()).value?.threads).toEqual([]);
  const documentChanged = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>();
  const stop = store.subscribe(documentChanged);

  try {
    const input = command({
      type: "feedback",
      reviewId,
      action: { type: "post", ...question },
    });

    await client.post("/commands", input);
    expect((await first.next()).value?.threads[0]?.messages[0]?.body).toEqual(
      question.body,
    );
    expect((await second.next()).value?.threads).toHaveLength(1);
    await client.post("/commands", input);
    expect(documentChanged).not.toHaveBeenCalled();
    expect(store.feedback.read(reviewId).threads[0]!.messages).toHaveLength(1);
  } finally {
    await first.return(undefined);
    await second.return(undefined);
    abort.abort();
    stop();
  }

  const reconnect = client.watch<FeedbackSnapshot>(
    reviewId,
    new AbortController().signal,
    "feedback",
  );

  expect((await reconnect.next()).value?.threads).toEqual(
    store.feedback.read(reviewId).threads,
  );
  await reconnect.return(undefined);
  expect((await app.request("/reviews-api/missing/feedback")).status).toBe(404);
});
