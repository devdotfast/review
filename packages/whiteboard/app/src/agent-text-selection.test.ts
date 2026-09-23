// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

import { observeAgentTextSelection } from "./agent-text-selection";

it("captures exact prose and its anchor, clears collapsed selections, and ignores native editors", () => {
  const article = document.createElement("article");
  article.innerHTML =
    '<p data-whiteboard-copy-prose>before <strong>selected words</strong> after</p><div class="monaco-editor">code</div>';
  document.body.append(article);
  const select = vi.fn<Parameters<typeof observeAgentTextSelection>[1]>();
  const stop = observeAgentTextSelection(article, select);
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(article.querySelector("strong")!);
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({ left: 20, top: 50, width: 100 }),
  });

  try {
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).toHaveBeenLastCalledWith({
      target: { kind: "text", quote: "selected words" },
      title: "selected words",
      anchor: { x: 70, y: 50 },
      anchorElement: article.querySelector("strong"),
    });
    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).toHaveBeenLastCalledWith(null);
    select.mockClear();
    range.selectNodeContents(article.querySelector(".monaco-editor")!);
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).not.toHaveBeenCalled();
    stop();
    range.selectNodeContents(article.querySelector("strong")!);
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).not.toHaveBeenCalled();
  } finally {
    stop();
    selection.removeAllRanges();
    article.remove();
  }
});

it.each([
  '<figure class="sequence-diagram"><span>sequence actor</span></figure>',
  '<figure class="database-lens"><span>Orders</span></figure>',
  '<figure class="software-map"><span>Service</span></figure>',
  '<figure class="whiteboard-image"><figcaption>Image caption</figcaption></figure>',
  "<div data-whiteboard-copy-prose><pre>authored code block</pre></div>",
  "<div data-whiteboard-copy-prose><div data-whiteboard-copy-ignore>PR metadata</div></div>",
])("ignores non-prose content: %s", (html) => {
  const article = document.createElement("article");
  article.innerHTML = html;
  document.body.append(article);
  const select = vi.fn<Parameters<typeof observeAgentTextSelection>[1]>();
  const stop = observeAgentTextSelection(article, select);
  const selection = document.getSelection()!;
  const range = document.createRange();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  range.selectNodeContents(walker.nextNode()!);

  try {
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).not.toHaveBeenCalled();
  } finally {
    stop();
    selection.removeAllRanges();
    article.remove();
  }
});

it("rejects selections crossing a diagram, but permits consecutive prose blocks", () => {
  const article = document.createElement("article");
  article.innerHTML =
    "<p data-whiteboard-copy-prose>First</p><figure>Diagram label</figure><p data-whiteboard-copy-prose>Last</p>";
  document.body.append(article);
  const select = vi.fn<Parameters<typeof observeAgentTextSelection>[1]>();
  const stop = observeAgentTextSelection(article, select);
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.setStart(article.firstElementChild!.firstChild!, 0);
  range.setEnd(article.lastElementChild!.firstChild!, 4);
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 10 }),
  });

  try {
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).not.toHaveBeenCalled();
    article.querySelector("figure")!.remove();
    document.dispatchEvent(new Event("selectionchange"));
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { kind: "text", quote: "FirstLast" } }),
    );
  } finally {
    stop();
    selection.removeAllRanges();
    article.remove();
  }
});
