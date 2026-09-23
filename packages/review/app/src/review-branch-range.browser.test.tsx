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
  it("shows short hashes and copies the full pinned commits", async () => {
    const base = "96add9c5f99b711a034df5fa2d685ed9d288bc61";
    const head = "9cf5a775c4c6815c719166ca4bf77eb2fe9d1e03";
    const session = testReviewSession();
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <ReviewSessionProvider session={session}>
          <ReviewBranchRange baseRef={base} headRef={head} />
        </ReviewSessionProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const baseCopy = container.querySelector<HTMLButtonElement>(
      `[aria-label="Copy base commit hash ${base}"]`,
    );

    const headCopy = container.querySelector<HTMLButtonElement>(
      `[aria-label="Copy head commit hash ${head}"]`,
    );

    expect(baseCopy?.textContent).toBe(base.slice(0, 8));
    expect(headCopy?.textContent).toBe(head.slice(0, 8));
    await act(async () => baseCopy?.click());
    expect(writeText).toHaveBeenLastCalledWith(base);
    expect(baseCopy?.querySelector('[role="status"]')?.textContent).toBe(
      "Copied",
    );
    await act(async () => headCopy?.click());
    expect(writeText).toHaveBeenLastCalledWith(head);
    expect(headCopy?.querySelector('[role="status"]')?.textContent).toBe(
      "Copied",
    );
    expect(baseCopy?.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
