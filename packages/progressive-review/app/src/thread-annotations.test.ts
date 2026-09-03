// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { ThreadTarget } from "../../src/types";
import { targetKey } from "./target-fingerprint";
import {
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  MARGIN_CARDS_MIN_GUTTER,
  annotationForThread,
  gutterForAvailable,
  scrollTargetForThread,
  textNodeClientRects,
  threadFitsExpandedCard,
} from "./thread-annotations";

/** A DOMRectList backed by the given rects, for stubbing Range.getClientRects. */
function domRectList(...rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  });
}

describe("scrollTargetForThread", () => {
  const proseTarget: ThreadTarget = {
    kind: "text",
    surface: { type: "document", documentHash: "document-hash" },
    selection: {
      start: 0,
      length: 5,
      hash: "selection-hash",
      quote: "hello",
    },
  };

  function articleWith(html: string): HTMLElement {
    document.body.innerHTML = `<article class="review-document">${html}</article>`;
    return document.querySelector<HTMLElement>(".review-document")!;
  }

  it("prefers a real locator outside the annotation layer", () => {
    const key = targetKey(proseTarget);
    const article = articleWith(
      `<p data-review-locator="${key}">real</p>` +
        `<div class="review-annotations"><div class="review-highlight" data-review-locator="${key}"></div></div>`,
    );

    expect(scrollTargetForThread(article, proseTarget)?.tagName).toBe("P");
  });

  it("falls back to the thread's highlight for prose targets", () => {
    const key = targetKey(proseTarget);
    const article = articleWith(
      `<p>prose</p>` +
        `<div class="review-annotations"><div class="review-highlight" data-review-locator="${key}"></div></div>`,
    );

    const element = scrollTargetForThread(article, proseTarget);
    expect(element?.classList.contains("review-highlight")).toBe(true);
  });

  it("returns null when neither a locator nor a highlight exists", () => {
    const article = articleWith(
      `<p>prose</p><div class="review-annotations"></div>`,
    );

    expect(scrollTargetForThread(article, proseTarget)).toBeNull();
  });
});

describe("annotationForThread", () => {
  it("places a cross-paragraph comment pin in the selected prose margin", () => {
    const article = document.createElement("article");
    article.innerHTML =
      '<h2 data-review-block-index="0">Selection behavior</h2>' +
      '<p data-review-block-index="1">First paragraph</p>';
    document.body.append(article);
    const heading = article.querySelector("h2")!;
    const paragraph = article.querySelector("p")!;
    const headingText = heading.firstChild!;
    const articleRect = new DOMRect(100, 40, 860, 600);
    const headingRect = new DOMRect(164, 80, 170, 26);
    const paragraphRect = new DOMRect(164, 118, 720, 52);
    const headingLine = new DOMRect(164, 82, 170, 22);
    const paragraphLine = new DOMRect(164, 120, 420, 18);
    vi.spyOn(article, "getBoundingClientRect").mockReturnValue(articleRect);
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(headingRect);
    vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(paragraphRect);

    const rangePrototype = Range.prototype;
    const originalGetClientRects = Object.getOwnPropertyDescriptor(
      rangePrototype,
      "getClientRects",
    );
    Object.defineProperty(rangePrototype, "getClientRects", {
      configurable: true,
      value: vi.fn<() => DOMRectList>(function (this: Range): DOMRectList {
        return domRectList(
          this.startContainer === headingText ? headingLine : paragraphLine,
        );
      }),
    });

    try {
      const [annotation] = annotationForThread(
        article,
        articleRect,
        {
          kind: "text",
          surface: { type: "document", documentHash: "document-hash" },
          selection: {
            start: 0,
            length: "Selection behavior First paragraph".length,
            hash: "selection-hash",
            quote: "Selection behavior First paragraph",
          },
        },
        {
          key: "thread-cross-paragraph",
          threadId: "thread-cross-paragraph",
          kind: "comment",
          index: 1,
          status: "persisted",
        },
      );

      expect(annotation?.marker).toEqual({ x: 792, y: 40 });
      expect(annotation?.blockRight).toBe(784);
    } finally {
      if (originalGetClientRects) {
        Object.defineProperty(
          rangePrototype,
          "getClientRects",
          originalGetClientRects,
        );
      } else {
        Reflect.deleteProperty(rangePrototype, "getClientRects");
      }
      article.remove();
    }
  });
});

describe("textNodeClientRects", () => {
  it("measures selected text nodes without measuring the spanning range", () => {
    const article = document.createElement("article");
    article.innerHTML =
      "<h2>Selection behavior</h2><p>First paragraph</p><p>Second paragraph</p>";
    document.body.append(article);
    const headingText = article.querySelector("h2")!.firstChild!;
    const firstParagraphText = article.querySelectorAll("p")[0]!.firstChild!;
    const secondParagraphText = article.querySelectorAll("p")[1]!.firstChild!;
    const selection = document.createRange();
    selection.setStart(headingText, 0);
    selection.setEnd(
      secondParagraphText,
      secondParagraphText.textContent!.length,
    );

    const enclosingParagraph = { width: 720, height: 77 } as DOMRect;
    const headingLine = { width: 170, height: 22 } as DOMRect;
    const firstParagraphLine = { width: 720, height: 15 } as DOMRect;
    const secondParagraphLine = { width: 410, height: 15 } as DOMRect;
    const measuredRanges: Range[] = [];
    const rangePrototype = Object.getPrototypeOf(selection) as Range;
    const originalGetClientRects = Object.getOwnPropertyDescriptor(
      rangePrototype,
      "getClientRects",
    );
    const getClientRects = vi.fn<() => DOMRectList>(
      function (this: Range): DOMRectList {
        measuredRanges.push(this);
        if (this === selection) {
          return domRectList(enclosingParagraph);
        }
        if (this.startContainer === headingText) {
          return domRectList(headingLine);
        }
        if (this.startContainer === firstParagraphText) {
          return domRectList(firstParagraphLine);
        }
        return domRectList(secondParagraphLine);
      },
    );
    Object.defineProperty(rangePrototype, "getClientRects", {
      configurable: true,
      value: getClientRects,
    });

    try {
      expect(textNodeClientRects(selection, article)).toEqual([
        headingLine,
        firstParagraphLine,
        secondParagraphLine,
      ]);
      expect(measuredRanges).not.toContain(selection);
      expect(
        measuredRanges.every(
          (range) => range.startContainer.nodeType === Node.TEXT_NODE,
        ),
      ).toBe(true);
    } finally {
      if (originalGetClientRects) {
        Object.defineProperty(
          rangePrototype,
          "getClientRects",
          originalGetClientRects,
        );
      } else {
        Reflect.deleteProperty(rangePrototype, "getClientRects");
      }
      article.remove();
    }
  });
});

describe("gutterForAvailable", () => {
  it("falls back to markers below the card threshold", () => {
    const gutter = gutterForAvailable(MARGIN_CARDS_MIN_GUTTER - 1, 700);

    expect(gutter).toEqual({ mode: "markers", left: 708, width: 0 });
  });

  it("shows the narrowest useful card exactly at the threshold", () => {
    const gutter = gutterForAvailable(MARGIN_CARDS_MIN_GUTTER, 700);

    expect(gutter).toEqual({
      mode: "cards",
      left: 718,
      width: CARD_MIN_WIDTH,
    });
  });

  it("fills the gutter, keeping the inset and trailing margin", () => {
    // Every extra pixel of gutter is an extra pixel of card, until the ceiling.
    const narrow = gutterForAvailable(MARGIN_CARDS_MIN_GUTTER + 60, 700);
    expect(narrow.width).toBe(CARD_MIN_WIDTH + 60);
    expect(gutterForAvailable(MARGIN_CARDS_MIN_GUTTER + 200, 700).width).toBe(
      CARD_MIN_WIDTH + 200,
    );
  });

  it("never grows a card wider than the prose it annotates", () => {
    expect(gutterForAvailable(2000, 700).width).toBe(CARD_MAX_WIDTH);
  });
});

describe("threadFitsExpandedCard", () => {
  const width = 440;

  it("expands a short thread", () => {
    expect(
      threadFitsExpandedCard(["what is the expected speed up of this?"], width),
    ).toBe(true);
  });

  it("collapses a thread too tall for the margin", () => {
    expect(threadFitsExpandedCard([" ".repeat(4000)], width)).toBe(false);
  });

  it("counts hard line breaks, not just wrapped length", () => {
    const short = "x".repeat(20);
    expect(threadFitsExpandedCard([short], width)).toBe(true);
    expect(
      threadFitsExpandedCard(
        [Array.from({ length: 40 }, () => short).join("\n")],
        width,
      ),
    ).toBe(false);
  });

  it("fits less text as the card narrows", () => {
    const body = "y".repeat(1200);
    expect(threadFitsExpandedCard([body], 700)).toBe(true);
    expect(threadFitsExpandedCard([body], 280)).toBe(false);
  });
});
