// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { ApiComments } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ReviewApiClient } from "../../src/review-api/client";
import { createReviewApi } from "../../src/review-api/http";
import { ReviewQuestions } from "../../src/review-api/questions";
import { ReviewStore } from "../../src/review-api/store";

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

it.each(["head", "base", "commit"] as const)(
  "opens the original %s location after repinning, not the current file",
  async (side) => {
    const client = new ReviewApiClient(
      { serverUrl: "http://review", token: "test" },
      async (url, init) => app.request(url, init),
    );

    comments = new ApiComments(
      client,
      reviewId,
      () => store.read(reviewId).version,
    );

    const row = (line: number) => ({
      old_line: side === "base" ? line : null,
      new_line: side === "base" ? null : line,
    });

    const position = createGitLabTextDiffPosition({
      base_sha: side === "commit" ? "parent" : "base",
      start_sha: side === "commit" ? "parent" : "base",
      // Selected final commit: same head but different comparison base.
      head_sha: "head",
      old_path: "old.ts",
      new_path: "renamed.ts",
      start: row(3),
      end: row(5),
    });

    const question = {
      ...input(),
      target: { kind: "code" as const, original_position: position, position },
    };

    await comments.saveComment(question);
    await command({
      type: "repin",
      reviewId,
      pins: {
        ...store.read(reviewId).pins,
        base: "new-base",
        head: "new-head",
      },
    });
    await comments.refresh();
    expect(await comments.originalSource(question.threadId)).toEqual({
      source: {
        version: 0,
        side: side === "base" ? "base" : "head",
        file: side === "base" ? "old.ts" : "renamed.ts",
        commit: side === "commit" ? "head" : undefined,
      },
      range: { startLine: 3, endLine: 5 },
    });
  },
);

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

it("restores running status after a canvas reload, streams failure, and retries the saved question once", async () => {
  let fail!: (error: Error) => void;

  const execute = vi.fn<() => Promise<string>>(
    () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      }),
  );

  const questions = new ReviewQuestions(store, execute);
  app = new Hono().route(
    "/reviews-api",
    createReviewApi(store, undefined, undefined, questions),
  );
  const routes: string[] = [];

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => {
      routes.push(new URL(url).pathname);

      return app.request(url, init);
    },
  );

  try {
    comments = new ApiComments(client, reviewId, () => 0);
    comments.start();
    const question = input();
    await comments.askAgent(question);
    expect(
      comments.getSnapshot().agentActivities.get(question.threadId)?.status,
    ).toBe("running");
    comments.dispose();
    comments = new ApiComments(client, reviewId, () => 0);
    comments.start();
    await comments.refresh();
    expect(
      comments.getSnapshot().agentActivities.get(question.threadId)?.status,
    ).toBe("running");
    expect(comments.canRetryAgent(question.threadId)).toBe(false);
    fail(new Error("Disconnected"));
    await vi.waitFor(() =>
      expect(
        comments.getSnapshot().agentActivities.get(question.threadId)?.status,
      ).toBe("failed"),
    );
    expect(comments.canRetryAgent(question.threadId)).toBe(true);
    execute.mockResolvedValue("Recovered answer.");
    await comments.retryAgent(question.threadId);
    await vi.waitFor(() =>
      expect(
        comments.getSnapshot().commentThreads.get(question.threadId)?.messages,
      ).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(comments.getSnapshot().agentActivities.size).toBe(0),
    );
    expect(comments.canRetryAgent(question.threadId)).toBe(false);
    await comments.retryAgent(question.threadId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(routes.some((route) => route.includes("/runs/"))).toBe(false);
  } finally {
    questions.close();
  }
});

it("restores the conversation's terminal association and opens only its own run", async () => {
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => {});

  const questions = new ReviewQuestions(store, async (input) => {
    input.onSession({ harness: "claude-code", sessionId: "session-a" }, open);

    return "Saved answer.";
  });

  app = new Hono().route(
    "/reviews-api",
    createReviewApi(store, undefined, undefined, questions),
  );

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => app.request(url, init),
  );

  try {
    comments = new ApiComments(client, reviewId, () => 0);
    const question = input();
    await comments.askAgent(question);
    await vi.waitFor(() =>
      expect(questions.read(reviewId, question.messageId).status).toBe(
        "completed",
      ),
    );
    comments.dispose();
    comments = new ApiComments(client, reviewId, () => 0);
    await comments.refresh();
    expect(
      comments.getSnapshot().commentThreads.get(question.threadId)
        ?.agentSession,
    ).toEqual({ harness: "claude-code", sessionId: "session-a" });
    questions.terminalClosed(reviewId, question.messageId, "session-a");
    await Promise.all([
      comments.openTerminal(question.threadId),
      comments.openTerminal(question.threadId),
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0].aborted).toBe(false);
    await expect(comments.openTerminal("unrelated-thread")).rejects.toThrow(
      "no available agent terminal",
    );
    expect(
      (
        await app.request(
          `/reviews-api/unrelated-review/runs/${question.messageId}/terminal`,
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
    expect(open).toHaveBeenCalledTimes(1);
    questions.close();
    await comments.refresh();
    expect(
      comments.getSnapshot().commentThreads.get(question.threadId)
        ?.agentSession,
    ).toBeUndefined();
    expect(
      comments.getSnapshot().commentThreads.get(question.threadId)?.messages,
    ).toHaveLength(2);
  } finally {
    questions.close();
  }
});

it("retries an unanswered saved request-changes batch after the host loses runtime state", async () => {
  let questions = new ReviewQuestions(store, async () => {
    throw new Error("Could not launch");
  });

  app = new Hono().route(
    "/reviews-api",
    createReviewApi(store, undefined, undefined, questions),
  );

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "test" },
    async (url, init) => app.request(url, init),
  );

  try {
    comments = new ApiComments(client, reviewId, () => 0);
    const selected = [input(), input()];

    for (const question of selected) await comments.saveComment(question);
    const submissionId = randomUUID();
    await comments.submit("request-changes", submissionId, selected);
    questions.close();

    const execute = vi.fn<() => Promise<string>>(async () =>
      JSON.stringify({
        replies: selected.map((question) => ({
          threadId: question.threadId,
          body: "Updated.",
        })),
      }),
    );

    questions = new ReviewQuestions(store, execute);
    app = new Hono().route(
      "/reviews-api",
      createReviewApi(store, undefined, undefined, questions),
    );
    await comments.refresh();
    expect(comments.canRetryAgent(selected[0]!.threadId)).toBe(true);
    await comments.retryAgent(selected[0]!.threadId);
    await vi.waitFor(() =>
      expect(
        store.feedback
          .read(reviewId)
          .threads.every((thread) => thread.messages.length === 2),
      ).toBe(true),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.feedback.read(reviewId).submissions).toHaveLength(1);
    expect(questions.list(reviewId)[0]?.requestId).toBe(
      store.feedback.read(reviewId).submissions[0]!.id,
    );
  } finally {
    questions.close();
  }
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
