import { describe, expect, it } from "vitest";

import { normalizeQuoteText, textIncludesQuote } from "./evidence";

describe("quote evidence", () => {
  it("matches a quote across line wrapping and indentation", () => {
    const event = "The server\n  commits the edit\n  before replying.";

    expect(textIncludesQuote(event, "server commits the edit")).toBe(true);
    expect(textIncludesQuote(event, "  commits the\nedit  ")).toBe(true);
    expect(textIncludesQuote(event, "commits the reply")).toBe(false);
  });

  it("never matches an empty quote", () => {
    expect(normalizeQuoteText("  \n ")).toBe("");
    expect(textIncludesQuote("anything", " \n")).toBe(false);
  });
});
