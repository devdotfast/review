// @vitest-environment jsdom

import type { ReviewFindQuery } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  compileReviewFindQuery,
  regularExpressionMatches,
} from "./review-find-query";
import { reviewFindRanges, reviewFindText } from "./review-find-text";

function compile(overrides: Partial<ReviewFindQuery> = {}): RegExp {
  const result = compileReviewFindQuery({
    text: "Alpha",
    matchCase: false,
    wholeWord: false,
    isRegex: false,
    ...overrides,
  });
  if ("error" in result) throw new Error(result.error);
  return result.expression;
}

describe("Review Find queries", () => {
  it("applies case and whole-word options", () => {
    expect(regularExpressionMatches("alpha ALPHA", compile())).toHaveLength(2);
    expect(
      regularExpressionMatches("alpha Alpha", compile({ matchCase: true })),
    ).toHaveLength(1);
    expect(
      regularExpressionMatches(
        "Alpha Alphabet Alpha",
        compile({ wholeWord: true }),
      ),
    ).toHaveLength(2);
  });

  it("supports regular expressions and reports invalid expressions", () => {
    expect(
      regularExpressionMatches(
        "item-1 item-22",
        compile({ text: "item-\\d+", isRegex: true }),
      ),
    ).toHaveLength(2);
    expect(
      compileReviewFindQuery({
        text: "[",
        matchCase: false,
        wholeWord: false,
        isRegex: true,
      }),
    ).toHaveProperty("error");
  });

  it("skips zero-length regular expression matches", () => {
    expect(
      regularExpressionMatches("abc", compile({ text: "^|$", isRegex: true })),
    ).toEqual([]);
  });
});

describe("Review Find document text", () => {
  it("keeps authored DOM and excludes Review-owned surfaces", () => {
    const article = document.createElement("article");
    article.className = "review-document";
    article.innerHTML = `
      <h1>Authored heading</h1>
      <div><span>React component text</span></div>
      <svg><text>Diagram label</text></svg>
      <div class="review-doc-meta">metadata</div>
      <div class="selection-action-buttons">comment action</div>
      <div data-review-inline-editor="src/example.ts">hidden Monaco text</div>
      <div class="review-find-widget">find chrome</div>
    `;
    document.body.append(article);

    const text = reviewFindText(article);
    expect(text).toContain("Authored heading");
    expect(text).toContain("React component text");
    expect(text).toContain("Diagram label");
    expect(text).not.toContain("metadata");
    expect(text).not.toContain("comment action");
    expect(text).not.toContain("hidden Monaco text");
    expect(text).not.toContain("find chrome");
  });

  it("creates DOM ranges for each authored match", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Needle one</p><p>Needle two</p>";
    document.body.append(article);
    const ranges = reviewFindRanges(article, compile({ text: "Needle" }));
    expect(ranges.map((range) => range.toString())).toEqual([
      "Needle",
      "Needle",
    ]);
  });

  it("maps a normalized match across nested authored nodes", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Needle   <strong>one</strong></p>";
    document.body.append(article);
    const ranges = reviewFindRanges(article, compile({ text: "Needle one" }));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe("Needle   one");
  });
});
