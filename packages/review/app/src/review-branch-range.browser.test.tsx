import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewBranchRange } from "./review-branch-range";
import { testReviewSession } from "./review-session-test-utils";

import styles from "./styles.css?inline";

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const base = "96add9c5f99b711a034df5fa2d685ed9d288bc61";

const head = "9cf5a775c4c6815c719166ca4bf77eb2fe9d1e03";

async function renderRange(branches: { base?: string; head?: string } = {}) {
  const style = document.createElement("style");
  style.textContent = styles;
  const container = document.createElement("div");
  document.body.append(style, container);

  await act(async () => {
    root = createRoot(container);
    root.render(
      <ReviewSessionProvider session={testReviewSession()}>
        <ReviewBranchRange
          baseRef={base}
          headRef={head}
          baseBranch={branches.base}
          headBranch={branches.head}
        />
      </ReviewSessionProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return (name: string) =>
    container.querySelector<HTMLButtonElement>(
      `.review-branch-copy[aria-label$=" ${name}"]`,
    )!;
}

const nameOf = (button: HTMLButtonElement) =>
  button.querySelector(".review-branch-name")!.textContent;

describe("ReviewBranchRange", () => {
  it("shows short hashes and copies the full pinned commits", async () => {
    const button = await renderRange();

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const baseCopy = button(base);
    const headCopy = button(head);

    expect(nameOf(baseCopy)).toBe(base.slice(0, 8));
    expect(nameOf(headCopy)).toBe(head.slice(0, 8));
    await act(async () => baseCopy.click());
    expect(writeText).toHaveBeenLastCalledWith(base);
    expect(baseCopy.querySelector('[role="status"]')?.textContent).toBe(
      "Copied",
    );
    await act(async () => headCopy.click());
    expect(writeText).toHaveBeenLastCalledWith(head);
    expect(headCopy.querySelector('[role="status"]')?.textContent).toBe(
      "Copied",
    );
    expect(baseCopy.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("shows branch names when known and copies the branch name", async () => {
    const button = await renderRange({ base: "main", head: "feature" });

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    expect(nameOf(button("main"))).toBe("main");
    expect(nameOf(button("feature"))).toBe("feature");
    expect(button("feature").title).toBe("Copy branch name");
    await act(async () => button("feature").click());
    expect(writeText).toHaveBeenLastCalledWith("feature");
  });

  it("truncates a long branch name and still copies it in full", async () => {
    const long = `feature/${"very-long-branch-name-".repeat(6)}end`;
    const button = await renderRange({ head: long });
    const name = button(long).querySelector(".review-branch-name")!;

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    expect(nameOf(button(base))).toBe(base.slice(0, 8));
    expect(name.textContent).toBe(long);
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    await act(async () => button(long).click());
    expect(writeText).toHaveBeenLastCalledWith(long);
  });
});
