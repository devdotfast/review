import { describe, expect, it, vi } from "vitest";

import {
  TUTORIAL_QUESTION_SOURCE_WAIT_MS,
  resolveReviewQuestionRoute,
} from "./review-api";

type QuestionSourceResolver = NonNullable<
  Parameters<
    typeof resolveReviewQuestionRoute
  >[0]["resolveQuestionSourceSession"]
>;

describe("resolveReviewQuestionRoute", () => {
  it("awaits the prepared tutorial source before falling back to fresh", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = vi.fn<QuestionSourceResolver>(async () => {
      await ready;
      return { harness: "codex" as const, sessionId: "tutorial-source" };
    });

    const pending = resolveReviewQuestionRoute({
      freshQuestionHarness: "codex",
      resolveQuestionSourceSession: resolver,
    });
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledOnce();
    release();

    await expect(pending).resolves.toEqual({
      kind: "fork",
      source: { harness: "codex", sessionId: "tutorial-source" },
    });
  });

  it("uses the fresh route when preparation fails", async () => {
    await expect(
      resolveReviewQuestionRoute({
        freshQuestionHarness: "pi",
        resolveQuestionSourceSession: async () => {
          throw new Error("handoff failed");
        },
      }),
    ).resolves.toEqual({ kind: "new", harness: "pi" });
  });

  it("falls back after the bounded tutorial wait and aborts the waiter", async () => {
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

    const pending = resolveReviewQuestionRoute({
      freshQuestionHarness: "codex",
      resolveQuestionSourceSession: resolver,
    });
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledWith(TUTORIAL_QUESTION_SOURCE_WAIT_MS);
    expect(TUTORIAL_QUESTION_SOURCE_WAIT_MS).toBe(5_000);
    controller.abort();

    await expect(pending).resolves.toEqual({ kind: "new", harness: "codex" });
    expect(resolver).toHaveBeenCalledWith(controller.signal);
  });

  it("does not prepare when a stored or static session already exists", async () => {
    const resolver = vi.fn<QuestionSourceResolver>(async () => undefined);
    await expect(
      resolveReviewQuestionRoute({
        storedSession: { harness: "pi", sessionId: "thread" },
        resolveQuestionSourceSession: resolver,
      }),
    ).resolves.toEqual({
      kind: "resume",
      session: { harness: "pi", sessionId: "thread" },
    });
    await expect(
      resolveReviewQuestionRoute({
        agent: { harness: "claude-code", sessionId: "author" },
        resolveQuestionSourceSession: resolver,
      }),
    ).resolves.toEqual({
      kind: "fork",
      source: { harness: "claude-code", sessionId: "author" },
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
