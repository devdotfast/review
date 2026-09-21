import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewBranchRange } from "./review-branch-range";
import { testReviewSession } from "./review-session-test-utils";

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ReviewBranchRange", () => {
  it("renders copyable refs and links only remotely available branches", async () => {
    const request = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            baseRef: "main",
            headRef: "local-work",
            baseUrl: "https://github.com/devdotfast/review/tree/main",
            headUrl: null,
          }),
        ),
    );

    const session = testReviewSession({}, { request });
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewSessionProvider session={session}>
          <ReviewBranchRange baseRef="base-commit" headRef="head-commit" />
        </ReviewSessionProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await expect.poll(() => container.textContent).toContain("local-work");

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const baseCopy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy base branch main"]',
    );

    const headCopy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy head branch local-work"]',
    );

    expect(baseCopy).not.toBeNull();
    expect(headCopy).not.toBeNull();
    await act(async () => baseCopy?.click());
    expect(writeText).toHaveBeenLastCalledWith("main");
    await act(async () => headCopy?.click());
    expect(writeText).toHaveBeenLastCalledWith("local-work");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/devdotfast/review/tree/main",
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/branch-links"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
