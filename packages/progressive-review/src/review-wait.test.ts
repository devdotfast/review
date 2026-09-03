import { PassThrough } from "node:stream";

import { REVIEW_DESKTOP_DISCOVERY_VERSION } from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  type ReviewCodexWaitDependencies,
  codexReviewMessageId,
  codexReviewWakePrompt,
  runReviewCodexWait,
} from "./review-codex-wait";
import type { StoredReview } from "./review-home";
import {
  type ReviewWaitDependencies,
  runReviewWait,
  waitForReviewAction,
} from "./review-wait";

const review = {
  dir: "/tmp/reviews/99d4519f-5a72-4684-9af4-98abaa2849cc",
  review: {
    uuid: "99d4519f-5a72-4684-9af4-98abaa2849cc",
    title: "Codex wake-up",
    status: "awaiting-review",
    lastPublishedAt: "2026-08-13T12:00:00.000Z",
    presentedDocumentRevision: "a".repeat(40),
  },
} as StoredReview;

const codexResult = {
  event: "review-status" as const,
  uuid: review.review.uuid,
  status: "awaiting-agent-updates" as const,
  decision: "request-changes" as const,
  openThreads: 2,
  occurredAtMs: 1234,
  review,
};

const codexWaitInput = {
  cwd: "/worktree",
  env: { CODEX_HOME: "/tmp/codex" },
  ownerToken: "owner-1",
  reviewUuid: review.review.uuid,
  threadId: "thread-1",
  timeoutSeconds: 5,
};

function codexDependencies(
  overrides: Partial<ReviewCodexWaitDependencies> = {},
): ReviewCodexWaitDependencies {
  return {
    clearWaiter: async () => undefined,
    deliverMessage: async (_input, deliver) => {
      await deliver();
      return true;
    },
    wakeCodex: async () => undefined,
    waitForReviewAction: async () => codexResult,
    ...overrides,
  };
}

function dependencies(
  stream: ReadableStream<Uint8Array>,
): ReviewWaitDependencies {
  return {
    fetch: async () => ({ body: stream, ok: true, status: 200 }) as Response,
    now: () => 1234,
    readDesktopDiscovery: async () => ({
      version: REVIEW_DESKTOP_DISCOVERY_VERSION,
      instanceId: "instance",
      url: "http://review",
      appPid: 1,
      serverPid: 2,
      token: "token",
      startedAt: 3,
    }),
    readOpenReviewThreadCount: () => 2,
    resolvePublishReview: async () => review,
    resolveReviewRoot: async () => "/worktree",
  };
}

function statusEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            event: "review-status-changed",
            uuid: review.review.uuid,
            status: "awaiting-agent-updates",
            decision: "request-changes",
          })}\n\n`,
        ),
      );
    },
  });
}

function deletedEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            event: "review-deleted",
            uuid: review.review.uuid,
          })}\n\n`,
        ),
      );
    },
  });
}

describe("Review wait", () => {
  it("shares the SSE wait core with the foreground waiter", async () => {
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewWait(
        { cwd: "/worktree", requiresAgent: true, stdout },
        dependencies(statusEventStream()),
      ),
    ).resolves.toBe(0);

    expect(output).toBe(
      `${JSON.stringify({
        event: "review-status",
        uuid: review.review.uuid,
        status: "awaiting-agent-updates",
        decision: "request-changes",
        openThreads: 2,
      })}\n`,
    );
  });

  it("closes the wait when the review is deleted", async () => {
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewWait(
        { cwd: "/worktree", stdout },
        dependencies(deletedEventStream()),
      ),
    ).resolves.toBe(0);

    expect(output).toBe(
      `${JSON.stringify({
        event: "review-deleted",
        uuid: review.review.uuid,
      })}\n`,
    );
  });

  it("returns the deleted result for the detached consumer", async () => {
    await expect(
      waitForReviewAction(
        {
          cwd: "/worktree",
          reviewUuid: review.review.uuid,
          requiresAgent: true,
        },
        dependencies(deletedEventStream()),
      ),
    ).resolves.toMatchObject({
      event: "review-deleted",
      uuid: review.review.uuid,
      occurredAtMs: 1234,
    });
  });

  it("returns the SSE status result for the detached consumer", async () => {
    await expect(
      waitForReviewAction(
        { cwd: "/worktree", reviewUuid: review.review.uuid },
        dependencies(statusEventStream()),
      ),
    ).resolves.toMatchObject({
      event: "review-status",
      status: "awaiting-agent-updates",
      decision: "request-changes",
      openThreads: 2,
      occurredAtMs: 1234,
    });
  });

  it("wakes Codex with the formatted result and stable dedupe key", async () => {
    const wakeCodex = vi.fn<ReviewCodexWaitDependencies["wakeCodex"]>(
      async () => undefined,
    );
    const clearWaiter = vi.fn<ReviewCodexWaitDependencies["clearWaiter"]>(
      async () => undefined,
    );

    await expect(
      runReviewCodexWait(
        codexWaitInput,
        codexDependencies({
          clearWaiter,
          wakeCodex,
        }),
      ),
    ).resolves.toBe(0);

    const messageId = codexReviewMessageId(codexResult);
    expect(wakeCodex).toHaveBeenCalledWith({
      clientUserMessageId: messageId,
      env: { CODEX_HOME: "/tmp/codex" },
      prompt: codexReviewWakePrompt(codexResult),
      threadId: "thread-1",
    });
    expect(clearWaiter).toHaveBeenCalledWith(
      expect.objectContaining({ ownerToken: "owner-1" }),
    );
  });

  it("builds message IDs from the publish round and outcome", () => {
    expect(codexReviewMessageId({ ...codexResult, occurredAtMs: 9999 })).toBe(
      codexReviewMessageId(codexResult),
    );
    expect(codexReviewMessageId({ ...codexResult, decision: undefined })).toBe(
      codexReviewMessageId(codexResult),
    );
    expect(
      codexReviewMessageId({
        ...codexResult,
        review: {
          ...review,
          review: {
            ...review.review,
            presentedDocumentRevision: "b".repeat(40),
          },
        },
      }),
    ).not.toBe(codexReviewMessageId(codexResult));
  });

  it("formats success and timeout wake prompts", () => {
    expect(
      codexReviewWakePrompt({
        event: "review-status",
        uuid: review.review.uuid,
        status: "awaiting-agent-updates",
        decision: "request-changes",
        openThreads: 2,
        occurredAtMs: 1234,
        review,
      }),
    ).toBe(`<automated_message>
This is an automated message from dev.fast Review. Review 99d4519f-5a72-4684-9af4-98abaa2849cc ("Codex wake-up") requires your attention.
Status: awaiting-agent-updates. Decision: request-changes. Open threads: 2.
Run \`review threads list --review 99d4519f-5a72-4684-9af4-98abaa2849cc\`. Address every open thread and resolve each one with \`review threads resolve <threadId> --review 99d4519f-5a72-4684-9af4-98abaa2849cc\`. List the threads again. Re-publish only when no open threads remain.
Run \`review wait --requires-agent --codex --review 99d4519f-5a72-4684-9af4-98abaa2849cc\` again if you need to block for the next reviewer action.
</automated_message>`);
    expect(
      codexReviewWakePrompt({
        event: "timeout",
        uuid: review.review.uuid,
        timeoutSeconds: 5,
        occurredAtMs: 1234,
        review,
      }),
    ).toBe(`<automated_message>
This is an automated message from dev.fast Review. The wait for review 99d4519f-5a72-4684-9af4-98abaa2849cc timed out after 5 seconds with no reviewer action.
Run \`review wait --requires-agent --codex --review 99d4519f-5a72-4684-9af4-98abaa2849cc\` again if you still need to block, or continue without it.
</automated_message>`);
    expect(
      codexReviewWakePrompt({
        event: "review-deleted",
        uuid: review.review.uuid,
        occurredAtMs: 1234,
        review,
      }),
    ).toBe(`<automated_message>
This is an automated message from dev.fast Review. The reviewer deleted review 99d4519f-5a72-4684-9af4-98abaa2849cc ("Codex wake-up").
The review and its threads no longer exist. Do not wait on or publish to this review again; continue without it.
</automated_message>`);
  });
});

function outputStream(): PassThrough {
  return new PassThrough();
}
