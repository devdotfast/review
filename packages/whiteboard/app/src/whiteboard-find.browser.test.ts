import type { WhiteboardFindQuery } from "@dev.fast/whiteboard-protocol";
import { describe, expect, it } from "vitest";

import {
  compileWhiteboardFindQuery,
  regularExpressionMatches,
} from "./whiteboard-find-query";
import { whiteboardFindRanges } from "./whiteboard-find-text";

function compile(overrides: Partial<WhiteboardFindQuery> = {}): RegExp {
  const result = compileWhiteboardFindQuery({
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
      compileWhiteboardFindQuery({
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
  it("creates DOM ranges for each authored match", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Needle one</p><p>Needle two</p>";
    document.body.append(article);
    const ranges = whiteboardFindRanges(article, compile({ text: "Needle" }));
    expect(ranges.map((range) => range.toString())).toEqual([
      "Needle",
      "Needle",
    ]);
  });

  it("maps a normalized match across nested authored nodes", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Needle   <strong>one</strong></p>";
    document.body.append(article);

    const ranges = whiteboardFindRanges(
      article,
      compile({ text: "Needle one" }),
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe("Needle   one");
  });
});
