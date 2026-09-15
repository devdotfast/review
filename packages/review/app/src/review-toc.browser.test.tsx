import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ReviewRoots, ReviewRootsProvider } from "./review-root-context";
import { ReviewToc } from "./review-toc";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

// The rail width effect only needs ResizeObserver to exist in these tests.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver as never;

function renderArticle(headings: string[]): HTMLElement {
  const article = document.createElement("article");
  article.className = "review-document";
  article.innerHTML = headings
    .map(
      (heading, index) =>
        `<h2 id="heading-${index}">${heading}</h2><p>body</p>`,
    )
    .join("");

  return article;
}

function tocLabels(): string[] {
  // Entries render with their section number prefixed; compare the titles.
  return [...document.querySelectorAll(".review-toc-link")].map((link) =>
    (link.textContent ?? "").trim().replace(/^[\d.]+/, ""),
  );
}

describe("ReviewToc", () => {
  let shell: HTMLElement;
  let region: HTMLElement;
  let view: HTMLElement;
  let mount: HTMLElement;
  let reviewRoots: ReviewRoots;

  beforeEach(() => {
    document.body.innerHTML = "";
    shell = document.createElement("main");
    shell.className = "review-document-shell";
    region = document.createElement("div");
    region.className = "review-view-region--review";
    view = document.createElement("div");
    view.className = "review-document-view";
    mount = document.createElement("div");
    view.append(mount);
    region.append(view);
    shell.append(region);
    document.body.append(shell);
    const app = document.createElement("div");
    reviewRoots = {
      appRef: { current: app },
      shellRef: { current: shell },
      scrollRegionRef: { current: region },
      articleRef: createRef<HTMLElement>(),
    };
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders supplied navigation entries with section numbers", () => {
    const firstArticle = renderArticle([
      "Interface change",
      "Scheduling sequence",
    ]);

    reviewRoots.articleRef.current = firstArticle;
    view.append(firstArticle);
    const root = createRoot(mount);
    mountedRoots.push(root);
    act(() => {
      root.render(
        <ReviewRootsProvider roots={reviewRoots}>
          <ReviewToc
            entries={[
              { id: "heading-0", text: "Interface change", level: "h2" },
              { id: "heading-1", text: "Scheduling sequence", level: "h2" },
            ]}
          />
        </ReviewRootsProvider>,
      );
    });
    expect(tocLabels()).toEqual(["Interface change", "Scheduling sequence"]);
    expect(
      document.querySelector(".review-toc-toggle-number")?.textContent?.trim(),
    ).toBe("1");
    expect(
      document.querySelector(".review-toc-toggle")?.textContent,
    ).not.toContain("§");
  });
});
