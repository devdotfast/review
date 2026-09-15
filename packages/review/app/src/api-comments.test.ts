// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ReviewApiClient } from "../../src/review-api/client";
import { createReviewApi } from "../../src/review-api/http";
import { ReviewStore } from "../../src/review-api/store";
import { ApiComments } from "./api-comments";

let directory: string, store: ReviewStore, app: Hono, reviewId: string;

let comments: ApiComments;

const command = <Operation>(operation: Operation) =>
  store.execute({ commandId: randomUUID(), operation });

const input = () => ({
  threadId: randomUUID(),
  messageId: randomUUID(),
  target: { kind: "document" as const },
  body: "Explain this choice.",
});

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-api-comments-"));
  store = new ReviewStore(path.join(directory, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  ({ reviewId } = await command({
    type: "create",
    title: "Comments",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  }));
  app = new Hono().route("/reviews-api", createReviewApi(store));
});

afterEach(async () => {
  comments?.dispose();
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

it("retries a lost save response against its original version without duplicating the question", async () => {
  let loseResponse = true;

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => {
      const response = await app.request(url, init);

      if (init?.method === "POST" && loseResponse) {
        loseResponse = false;
        throw new Error("Connection lost after saving.");
      }

      return response;
    },
  );

  comments = new ApiComments(
    client,
    reviewId,
    () => store.read(reviewId).version,
  );
  const question = input();
  await expect(comments.saveComment(question)).rejects.toThrow(
    "Connection lost",
  );
  await command({ type: "rename", reviewId, title: "Updated while retrying" });
  await comments.saveComment(question);
  const saved = store.feedback.read(reviewId).threads;
  expect(saved).toHaveLength(1);
  expect(saved[0]?.messages).toHaveLength(1);
  expect(saved[0]?.messages[0]).toMatchObject({
    id: question.messageId,
    version: 0,
    draft: true,
  });
  expect(comments.getSnapshot().pendingCommentCount).toBe(1);
});

it("does not replace a submitted conversation with an older delayed read", async () => {
  let delayRead = false;
  let release: () => void = () => {};

  let captured: () => void = () => {};

  const capture = new Promise<void>((resolve) => {
    captured = resolve;
  });

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => {
      const response = await app.request(url, init);

      if (delayRead && url.endsWith("/feedback")) {
        delayRead = false;
        captured();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      return response;
    },
  );

  comments = new ApiComments(client, reviewId, () => 0);
  const question = input();
  await comments.saveComment(question);
  expect(comments.canEditMessage(question.threadId, question.messageId)).toBe(
    true,
  );
  delayRead = true;
  const staleRead = comments.refresh();
  await capture;
  await comments.submit("request-changes", randomUUID(), [question]);
  release();
  await staleRead;
  expect(comments.getSnapshot().pendingCommentCount).toBe(0);
  expect(comments.canEditMessage(question.threadId, question.messageId)).toBe(
    false,
  );
  expect(
    comments.getSnapshot().commentThreads.get(question.threadId)?.messages,
  ).toHaveLength(1);
});
