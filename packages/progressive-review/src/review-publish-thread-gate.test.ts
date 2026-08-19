import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDir } from "./review-home";
import { runReviewPublish } from "./review-publish";
import {
  ReviewMissingAgentResponsesError,
  ReviewOpenThreadsError,
  requireClosedThreadsForRepublish,
  requireCompletedAgentResponsesForRepublish,
} from "./review-publish-thread-gate";
import {
  appendReviewAgentMessage,
  appendReviewComment,
  setReviewCommentAgentSession,
  updateReviewComment,
} from "./review-state-store";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((target) => rm(target, { recursive: true, force: true })),
  );
});

describe("requireClosedThreadsForRepublish", () => {
  it("permits the first publication with unusual pre-existing threads", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");

    expect(() => requireClosedThreadsForRepublish(review)).not.toThrow();
  });

  it("rejects a re-publish with sorted open thread IDs", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-z");
    addComment(review.dir, "thread-a");
    const published = {
      ...review,
      review: {
        ...review.review,
        presentedDocumentRevision: "published-revision",
      },
    };

    expect(() => requireClosedThreadsForRepublish(published)).toThrowError(
      expect.objectContaining({
        code: "review_open_threads",
        statusCode: 409,
        threadIds: ["thread-a", "thread-z"],
        message: expect.stringContaining(
          "review threads resolve <threadId> --review",
        ),
      }) as ReviewOpenThreadsError,
    );
  });

  it("permits a re-publish after every thread is resolved", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");
    updateReviewComment(path.join(review.dir, "review.mdx"), "thread-1", {
      status: "resolved",
    });

    expect(() =>
      requireClosedThreadsForRepublish({
        ...review,
        review: {
          ...review.review,
          presentedDocumentRevision: "published-revision",
        },
      }),
    ).not.toThrow();
  });

  it("reports the blocked re-publish as an NDJSON publish error", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");
    await writeFile(
      path.join(review.dir, "review.json"),
      `${JSON.stringify({
        ...review.review,
        presentedDocumentRevision: "published-revision",
      })}\n`,
      "utf8",
    );
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));
    const onReviewBound = vi.fn<(reviewUuid: string) => void>();

    await expect(
      runReviewPublish({
        cwd: review.review.worktreePath,
        reviewUuid: review.review.uuid,
        json: true,
        stdout: stdout as unknown as NodeJS.WriteStream,
        onReviewBound,
      }),
    ).resolves.toBe(1);
    expect(onReviewBound).toHaveBeenCalledOnce();
    expect(onReviewBound).toHaveBeenCalledWith(review.review.uuid);
    expect(JSON.parse(output.trim())).toEqual({
      event: "error",
      stage: "publish",
      diagnostics: [expect.stringContaining("thread-1")],
    });
  });
});

describe("requireCompletedAgentResponsesForRepublish", () => {
  it("rejects a current-round thread without a completed model response", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");
    updateReviewComment(path.join(review.dir, "review.mdx"), "thread-1", {
      status: "resolved",
    });

    expect(() =>
      requireCompletedAgentResponsesForRepublish({
        ...review,
        review: {
          ...review.review,
          presentedDocumentRevision: "published-revision",
          lastPublishedAt: "2000-01-01T00:00:00.000Z",
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "review_missing_agent_responses",
        statusCode: 409,
        threadIds: ["thread-1"],
      }) as ReviewMissingAgentResponsesError,
    );
  });

  it("accepts a current-round thread with a completed model response", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");
    updateReviewComment(path.join(review.dir, "review.mdx"), "thread-1", {
      status: "resolved",
    });
    const document = path.join(review.dir, "review.mdx");
    appendReviewAgentMessage(document, "thread-1", {
      id: "thread-1-agent-message",
      by: "Codex",
      at: new Date().toISOString(),
      body: "I addressed this comment.",
      role: "agent",
      format: "markdown",
    });
    setReviewCommentAgentSession(document, "thread-1", {
      harness: "codex",
      sessionId: "session-1",
    });

    expect(() =>
      requireCompletedAgentResponsesForRepublish({
        ...review,
        review: {
          ...review.review,
          presentedDocumentRevision: "published-revision",
          lastPublishedAt: "2000-01-01T00:00:00.000Z",
        },
      }),
    ).not.toThrow();
  });

  it("ignores resolved threads from an earlier round", async () => {
    const review = await createTestReview();
    addComment(review.dir, "thread-1");
    updateReviewComment(path.join(review.dir, "review.mdx"), "thread-1", {
      status: "resolved",
    });

    expect(() =>
      requireCompletedAgentResponsesForRepublish({
        ...review,
        review: {
          ...review.review,
          presentedDocumentRevision: "published-revision",
          lastPublishedAt: "2999-01-01T00:00:00.000Z",
        },
      }),
    ).not.toThrow();
  });
});

async function createTestReview() {
  const worktreePath = await mkdtemp(
    path.join(os.tmpdir(), "review-thread-gate-worktree-"),
  );
  const reviewHome = await mkdtemp(
    path.join(os.tmpdir(), "review-thread-gate-home-"),
  );
  cleanupPaths.push(worktreePath, reviewHome);
  vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
  return createReviewDir({
    worktreePath,
    baseRef: "base",
    baseCommit: "base",
    sourceCommit: "head",
    sourceIdentity: { kind: "git-branch", name: "feature" },
  });
}

function addComment(reviewDir: string, threadId: string): void {
  appendReviewComment(path.join(reviewDir, "review.mdx"), {
    threadId,
    messageId: `${threadId}-message`,
    target: {
      kind: "text",
      surface: {
        type: "block",
        tag: "p",
        index: 0,
        blockHash: "12345678",
      },
      selection: {
        start: 0,
        length: 4,
        hash: "12345678",
        quote: "text",
      },
    },
    body: "Please address this.",
    author: "Reviewer",
  });
}
