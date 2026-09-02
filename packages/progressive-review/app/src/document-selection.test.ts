// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  type SelectionTarget,
  documentSelectionTarget,
  observeDocumentSelection,
} from "./document-selection";

describe("document selection comments", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  });

  it("keeps the selection action mounted through mouseup on the action", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">Comment here.</p>' +
        '<div class="selection-action-buttons"><button type="button"></button></div>',
    );
    const text = article.querySelector("p")!.firstChild!;
    select(text, 0, text, 7);
    const targets: Array<SelectionTarget | null> = [];
    const stop = observeDocumentSelection(article, (target) =>
      targets.push(target),
    );
    document.dispatchEvent(new Event("selectionchange"));

    article
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    stop();
    expect(targets.at(-1)?.quote).toBe("Comment");
  });

  it("maps syntax-highlighted fenced code to the existing block target model", () => {
    const article = reviewArticle(
      '<pre data-review-block-index="7" data-review-block-tag="pre">' +
        '<code><span class="shj-syn-kwd">const</span> session = ' +
        '<span class="shj-syn-func">createAgentSession</span>();</code></pre>',
    );
    const functionName = article.querySelector(".shj-syn-func")!.firstChild!;
    const selection = select(
      functionName,
      0,
      functionName,
      "createAgentSession".length,
    );

    expect(documentSelectionTarget(selection, article)).toMatchObject({
      quote: "createAgentSession",
      target: {
        kind: "text",
        surface: { type: "block", tag: "pre", index: 7 },
        selection: { quote: "createAgentSession" },
      },
    });
  });

  it("preserves indentation and newlines in fenced-code selections", () => {
    const article = reviewArticle(
      '<pre data-review-block-index="7" data-review-block-tag="pre">' +
        "<code><span>  const first = true;</span>\n" +
        "<span>    return first;</span></code></pre>",
    );
    const lines = article.querySelectorAll("code span");
    const firstLine = lines[0]!.firstChild!;
    const secondLine = lines[1]!.firstChild!;
    const selection = select(
      firstLine,
      0,
      secondLine,
      secondLine.textContent!.length,
    );
    const quote = "  const first = true;\n    return first;";

    expect(documentSelectionTarget(selection, article)).toMatchObject({
      quote,
      target: {
        surface: { type: "block", tag: "pre" },
        selection: { start: 0, length: quote.length, quote },
      },
    });
  });

  it("keeps a whole-paragraph selection ending at the next block boundary", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">First paragraph.</p>' +
        '<p data-review-block-index="1" data-review-block-tag="p">Next paragraph.</p>',
    );
    const paragraphs = article.querySelectorAll("p");
    const selection = select(
      paragraphs[0]!.firstChild!,
      0,
      paragraphs[1]!.firstChild!,
      0,
    );

    expect(documentSelectionTarget(selection, article)).toMatchObject({
      quote: "First paragraph.",
      target: {
        surface: { type: "block", tag: "p", index: 0 },
        selection: { start: 0, length: 16, quote: "First paragraph." },
      },
    });
  });

  it("keeps a selection spanning neighboring paragraphs", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">First paragraph.</p>' +
        '<p data-review-block-index="1" data-review-block-tag="p">Next paragraph.</p>',
    );
    const paragraphs = article.querySelectorAll("p");
    const selection = select(
      paragraphs[0]!.firstChild!,
      6,
      paragraphs[1]!.firstChild!,
      4,
    );

    expect(documentSelectionTarget(selection, article)).toMatchObject({
      quote: "paragraph. Next",
      target: {
        surface: { type: "document" },
        selection: { quote: "paragraph. Next" },
      },
    });
  });

  it("keeps a paragraph selected from its surrounding block boundary", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">First paragraph.</p>' +
        '<p data-review-block-index="1" data-review-block-tag="p">Next paragraph.</p>',
    );
    const range = document.createRange();
    range.setStart(article, 0);
    range.setEnd(article, 1);
    const selection = installSelection(range);

    expect(documentSelectionTarget(selection, article)).toMatchObject({
      quote: "First paragraph.",
      target: {
        surface: { type: "block", tag: "p", index: 0 },
        selection: { quote: "First paragraph." },
      },
    });
  });

  it("captures a valid selection when the drag releases outside the article", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">Drag this paragraph.</p>',
    );
    const text = article.querySelector("p")!.firstChild!;
    select(text, 0, text, 9);
    const targets: Array<SelectionTarget | null> = [];
    const stop = observeDocumentSelection(article, (target) =>
      targets.push(target),
    );

    document.dispatchEvent(new Event("selectionchange"));

    stop();
    expect(targets.at(-1)?.quote).toBe("Drag this");
  });

  it("clears the comment action when the browser selection collapses", () => {
    const article = reviewArticle(
      '<p data-review-block-index="0" data-review-block-tag="p">Clear this selection.</p>',
    );
    const text = article.querySelector("p")!.firstChild!;
    const selection = select(text, 0, text, 10);
    const targets: Array<SelectionTarget | null> = [];
    const stop = observeDocumentSelection(article, (target) =>
      targets.push(target),
    );
    document.dispatchEvent(new Event("selectionchange"));

    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    stop();
    expect(targets.map((target) => target?.quote ?? null)).toEqual([
      "Clear this",
      null,
    ]);
  });
});

function reviewArticle(contents: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "review-document";
  article.innerHTML = contents;
  document.body.append(article);
  return article;
}

function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return installSelection(range);
}

function installSelection(range: Range): Selection {
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => new DOMRect(100, 80, 140, 20),
  });
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
