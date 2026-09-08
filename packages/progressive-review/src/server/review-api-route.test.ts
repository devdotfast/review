import { describe, expect, it, vi } from "vitest";

import {
  TUTORIAL_QUESTION_SOURCE_WAIT_MS,
  resolveReviewQuestionLaunch,
} from "./review-api";

type QuestionSourceResolver = NonNullable<
  Parameters<
    typeof resolveReviewQuestionLaunch
  >[0]["resolveQuestionSourceSession"]
>;

describe("resolveReviewQuestionLaunch", () => {
  it("awaits the configured tutorial source", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = vi.fn<QuestionSourceResolver>(async () => {
      await ready;
      return { harness: "codex" as const, sessionId: "tutorial-source" };
    });

    const pending = resolveReviewQuestionLaunch({
      freshQuestionHarness: "codex",
      resolveQuestionSourceSession: resolver,
    });
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledOnce();
    release();

    await expect(pending).resolves.toEqual({
      harness: "codex",
      session: { forkOf: "tutorial-source" },
    });
  });

  it("propagates preparation failure even when a fresh harness is configured", async () => {
    await expect(
      resolveReviewQuestionLaunch({
        freshQuestionHarness: "pi",
        resolveQuestionSourceSession: async () => {
          throw new Error("handoff failed");
        },
      }),
    ).rejects.toThrow("handoff failed");
  });

  it("rejects after the bounded tutorial wait and aborts the waiter", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const resolver = vi.fn<QuestionSourceResolver>(
      (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        }),
    );

    const pending = resolveReviewQuestionLaunch({
      freshQuestionHarness: "codex",
      resolveQuestionSourceSession: resolver,
    });
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledWith(TUTORIAL_QUESTION_SOURCE_WAIT_MS);
    expect(TUTORIAL_QUESTION_SOURCE_WAIT_MS).toBe(5_000);
    controller.abort();

    await expect(pending).rejects.toThrow("Timed out waiting");
    timeout.mockRestore();
    expect(resolver).toHaveBeenCalledWith(controller.signal);
  });

  it("rejects a configured source that reports no session", async () => {
    await expect(
      resolveReviewQuestionLaunch({
        freshQuestionHarness: "pi",
        resolveQuestionSourceSession: async () => undefined,
      }),
    ).rejects.toThrow("authoring session is not ready");
  });

  it("does not prepare when a stored or static session already exists", async () => {
    const resolver = vi.fn<QuestionSourceResolver>(async () => undefined);
    await expect(
      resolveReviewQuestionLaunch({
        storedSession: {
          harness: "pi",
          sessionId: "thread",
          state: "ready",
          firstMessageId: "ask",
        },
        resolveQuestionSourceSession: resolver,
      }),
    ).resolves.toEqual({ harness: "pi", session: { resume: "thread" } });
    await expect(
      resolveReviewQuestionLaunch({
        agent: { harness: "claude-code", sessionId: "author" },
        resolveQuestionSourceSession: resolver,
      }),
    ).resolves.toEqual({
      harness: "claude-code",
      session: { forkOf: "author" },
    });
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each([
    { state: "pending", firstMessageId: null },
    { state: "pending", firstMessageId: "earlier-ask" },
    { state: "repair-required" },
  ] as const)(
    "rejects an incomplete $state binding without selecting another session",
    async (state) => {
      await expect(
        resolveReviewQuestionLaunch({
          storedSession: {
            harness: "codex",
            sessionId: "uncertain-fork",
            ...state,
          },
          agent: { harness: "codex", sessionId: "author" },
        }),
      ).rejects.toThrow(/unconfirmed Ask|no native message boundary/);
    },
  );
});
