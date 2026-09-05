// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  reviewDocumentRange,
  reviewDocumentSelection,
  reviewDocumentText,
} from "./review-document-text";
import { buildDocumentTextTarget } from "./target-fingerprint";
import {
  type LiveThreadTargetModel,
  resolveTargetState,
} from "./thread-target-state";

describe("review document text", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps authored block boundaries and excludes app chrome", () => {
    article(
      `<h1>Review title</h1>` +
        `<div class="review-doc-meta">19 files updated now</div>` +
        `<p>First paragraph.</p>` +
        `<div class="review-annotations">Existing thread</div>` +
        `<p>Next paragraph.</p>` +
        `<div class="selection-action-buttons">Comment</div>`,
    );

    expect(reviewDocumentText(document.querySelector("article")!)).toBe(
      "Review title First paragraph. Next paragraph.",
    );
  });

  it("maps a canonical cross-paragraph selection back to its DOM range", () => {
    article(
      `<h1>Review title</h1>` +
        `<div class="review-doc-meta">19 files updated now</div>` +
        `<p>First paragraph.</p>` +
        `<p>Next paragraph.</p>`,
    );
    const articleEl = document.querySelector("article")!;
    const text = reviewDocumentText(articleEl);
    const quote = "paragraph. Next";
    const start = text.indexOf(quote);

    const range = reviewDocumentRange(articleEl, start, start + quote.length);

    expect(range?.toString()).toBe("paragraph.Next");
    expect(range?.startOffset).toBe(6);
    expect(range?.endOffset).toBe(4);
    expect(range?.startContainer.parentElement?.textContent).toBe(
      "First paragraph.",
    );
    expect(range?.endContainer.parentElement?.textContent).toBe(
      "Next paragraph.",
    );
  });

  it("excludes collapsed section summary chrome from canonical text", () => {
    // `ReviewSection` renders a `.review-section-meta` summary span into the
    // article only while a section is collapsed. That chrome is app chrome,
    // not authored text, and must not appear in the canonical document text
    // (which feeds the document-surface `documentHash`).
    article(
      collapsedSection(
        "Approach",
        '<p data-review-block-index="0" data-review-block-tag="p">' +
          "Approach description.</p>",
      ),
    );
    const collapsed = reviewDocumentText(document.querySelector("article")!);

    expect(collapsed).not.toContain("1 paragraph");
    expect(collapsed).toContain("Approach Approach description.");

    article(
      expandedSection(
        "Approach",
        '<p data-review-block-index="0" data-review-block-tag="p">' +
          "Approach description.</p>",
      ),
    );
    const expanded = reviewDocumentText(document.querySelector("article")!);
    expect(expanded).toBe(collapsed);
  });

  it("keeps a cross-section document-surface thread attached when the in-quote section collapses", () => {
    // A cross-section document-surface thread whose quote spans a section
    // heading must stay attached when that section is collapsed. Pre-fix the
    // `.review-section-meta` chrome split the contiguous quote, the quote
    // occurred zero times, and `resolveTargetState` returned `outdated`.
    article(sectionFixture(false));
    const articleEl = document.querySelector("article")!;
    const [oneBody, twoBody] = articleEl.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(oneBody!.firstChild!, "Section one ".length);
    range.setEnd(twoBody!.firstChild!, "starts".length);
    const documentSelection = reviewDocumentSelection(articleEl, range);
    const target = buildDocumentTextTarget({
      text: documentSelection!.text,
      start: documentSelection!.start,
      length: documentSelection!.selectionText.length,
    });
    expect(target.surface.type).toBe("document");
    expect(target.selection.quote.startsWith("ends here")).toBe(true);
    expect(target.selection.quote).toContain("Approach");
    expect(target.selection.quote).toContain("Section two");
    expect(target.selection.quote.endsWith("Section two starts")).toBe(true);

    article(sectionFixture(true));
    const collapsedText = reviewDocumentText(
      document.querySelector("article")!,
    );

    expect(collapsedText.indexOf(target.selection.quote)).toBe(
      target.selection.start,
    );
    expect(
      resolveTargetState({ target }, live({ documentText: collapsedText })),
    ).toMatchObject({
      state: "attached",
      target: {
        surface: { type: "document" },
        selection: { quote: target.selection.quote },
      },
    });
  });
});

function article(innerHtml: string): HTMLElement {
  const element = document.createElement("article");
  element.className = "review-document";
  element.innerHTML = innerHtml;
  document.body.replaceChildren(element);
  return element;
}

function sectionFixture(secondCollapsed: boolean): string {
  return (
    expandedSection(
      "Section one",
      '<p data-review-block-index="1" data-review-block-tag="p">' +
        "Section one ends here. Approach</p>",
    ) +
    (secondCollapsed ? collapsedSection : expandedSection)(
      "Section two",
      '<p data-review-block-index="3" data-review-block-tag="p">' +
        "starts here.</p>",
      { blockIndex: 2 },
    )
  );
}

function expandedSection(
  title: string,
  body: string,
  heading: { blockIndex: number } = { blockIndex: 0 },
): string {
  return (
    `<section class="review-section" data-review-section="${title}">` +
    '<div class="review-section-header"><div class="review-section-heading">' +
    `<h2 data-review-block-index="${heading.blockIndex}" data-review-block-tag="h2">${title}</h2>` +
    "</div></div>" +
    `<div class="review-section-body">${body}</div>` +
    "</section>"
  );
}

function collapsedSection(
  title: string,
  body: string,
  heading: { blockIndex: number } = { blockIndex: 0 },
): string {
  return (
    `<section class="review-section review-section--collapsed" data-review-section="${title}">` +
    '<div class="review-section-header"><div class="review-section-heading">' +
    `<h2 data-review-block-index="${heading.blockIndex}" data-review-block-tag="h2">${title}</h2>` +
    "</div>" +
    '<span class="review-section-meta">1 paragraph</span>' +
    "</div>" +
    `<div class="review-section-body" hidden>${body}</div>` +
    "</section>"
  );
}

function live(input: Partial<LiveThreadTargetModel>): LiveThreadTargetModel {
  return {
    blocks: [],
    documentText: null,
    tableCells: [],
    anchors: new Map(),
    diagrams: new Map(),
    ...input,
  };
}
