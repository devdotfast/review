// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

import { observeAgentTextSelection } from "./agent-text-selection";

it("captures exact prose and its anchor, clears collapsed selections, and ignores native editors", () => {
  const article = document.createElement("article");
  article.innerHTML =
    '<p>before <strong>selected words</strong> after</p><div class="monaco-editor">code</div>';
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
