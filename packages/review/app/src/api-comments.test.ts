// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ReviewApiClient } from "../../src/review-api/client";
import { createReviewApi } from "../../src/review-api/http";
import { ReviewQuestions } from "../../src/review-api/questions";
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
    pins: {
      repositoryId: store.registerRepository(directory).id,
      base: "base",
      head: "head",
    },
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

      if (delayRead && new URL(url).pathname.endsWith("/feedback")) {
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

it("reprojects unchanged feedback on a version switch and ignores a delayed old-version response", async () => {
  let version = 0;
  let delayRead = false;
  let release = () => {};

  let captured = () => {};

  const capture = new Promise<void>((resolve) => {
    captured = resolve;
  });

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => {
      const response = await app.request(url, init);

      if (!new URL(url).pathname.endsWith("/feedback")) return response;
      const body = await response.json();

      const position = createGitLabTextDiffPosition({
        base_sha: "base",
        start_sha: "base",
        head_sha: "head",
        old_path: "file.ts",
        new_path: "file.ts",
        start: {
          old_line: null,
          new_line: Number(new URL(url).searchParams.get("version")) + 1,
        },
        end: {
          old_line: null,
          new_line: Number(new URL(url).searchParams.get("version")) + 1,
        },
      });

      body.threads[0].target = {
        kind: "code",
        position,
        original_position: position,
      };

      if (delayRead) {
        delayRead = false;
        captured();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      return Response.json(body);
    },
  );

  comments = new ApiComments(client, reviewId, () => version);
  const question = input();
  await comments.saveComment(question);
  await command({ type: "rename", reviewId, title: "Next version" });
  await comments.refresh();
  delayRead = true;
  const oldRead = comments.refresh();
  await capture;
  version = 1;
  await comments.refresh();
  release();
  await oldRead;
  expect(
    comments.getSnapshot().commentThreads.get(question.threadId)?.target,
  ).toMatchObject({ position: { new_line: 2 } });
  version = 0;
  await comments.refresh();
  expect(
    comments.getSnapshot().commentThreads.get(question.threadId)?.target,
  ).toMatchObject({ position: { new_line: 1 } });
  expect(comments.getSnapshot().pendingCommentCount).toBe(1);
});

it("launches request-changes with the saved submission ID and receives its thread answer", async () => {
  const question = input();

  const questions = new ReviewQuestions(store, async () =>
    JSON.stringify({
      replies: [
        { threadId: question.threadId, body: "Here is the explanation." },
      ],
    }),
  );

  try {
    app = new Hono().route(
      "/reviews-api",
      createReviewApi(store, undefined, undefined, questions),
    );

    const client = new ReviewApiClient(
      { serverUrl: "http://review", token: "test" },
      async (url, init) => app.request(url, init),
    );

    let error: string | undefined;

    const failure = (message?: string) => {
      error = message;
    };

    comments = new ApiComments(client, reviewId, () => 0, failure);
    await comments.saveComment(question);
    await comments.submit("request-changes", randomUUID(), [question]);
    await vi.waitFor(() =>
      expect(store.feedback.read(reviewId).threads[0]!.messages).toHaveLength(
        2,
      ),
    );
    expect(error).toBeUndefined();
    expect(
      store.feedback.read(reviewId).threads[0]!.messages.at(-1),
    ).toMatchObject({ by: "agent", body: "Here is the explanation." });
  } finally {
    questions.close();
  }
});
