// @vitest-environment jsdom

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
          <ReviewBranchRange baseRef="main" headRef="local-work" />
        </ReviewSessionProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("base:main←head:local-work");
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/devdotfast/review/tree/main",
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/branch-links?baseRef=main&headRef=local-work"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
