import { describe, expect, it, vi } from "vitest";

import { resolveReviewQuestionLaunch } from "./review-api";

type QuestionSourceResolver = NonNullable<
  Parameters<
    typeof resolveReviewQuestionLaunch
  >[0]["resolveQuestionSourceSession"]
>;

describe("resolveReviewQuestionLaunch", () => {
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
