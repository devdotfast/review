// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  reviewDocumentRange,
  reviewDocumentText,
} from "./review-document-text";

describe("review document text", () => {
  it("keeps authored block boundaries and excludes app chrome", () => {
    document.body.innerHTML = `<article class="review-document"><h1>Review title</h1><div class="review-doc-meta">19 files updated now</div><p>First paragraph.</p><div class="review-annotations">Existing thread</div><p>Next paragraph.</p><div class="selection-action-buttons">Comment</div></article>`;
    const article = document.querySelector<HTMLElement>("article")!;

    expect(reviewDocumentText(article)).toBe(
      "Review title First paragraph. Next paragraph.",
    );
  });

  it("maps a canonical cross-paragraph selection back to its DOM range", () => {
    document.body.innerHTML = `<article class="review-document"><h1>Review title</h1><div class="review-doc-meta">19 files updated now</div><p>First paragraph.</p><p>Next paragraph.</p></article>`;
    const article = document.querySelector<HTMLElement>("article")!;
    const text = reviewDocumentText(article);
    const quote = "paragraph. Next";
    const start = text.indexOf(quote);

    const range = reviewDocumentRange(article, start, start + quote.length);

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
});
