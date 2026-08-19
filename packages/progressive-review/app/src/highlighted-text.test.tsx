import { describe, expect, it } from "vitest";

import { findWhitespaceNormalizedSpan } from "./highlighted-text";

describe("findWhitespaceNormalizedSpan", () => {
  it("finds exact substring match", () => {
    const text = "Hello world from trace";
    const span = findWhitespaceNormalizedSpan(text, "world from");
    expect(span).toEqual({ start: 6, end: 16 });
    expect(text.slice(span!.start, span!.end)).toBe("world from");
  });

  it("finds match across newlines and multiple spaces without shifting indices", () => {
    const text = "\n  First line\n\n  Second   line with details\n";
    const span = findWhitespaceNormalizedSpan(text, "Second line with");
    expect(span).not.toBeNull();
    // Must extract exact slice from original text preserving original whitespace
    expect(text.slice(span!.start, span!.end)).toBe("Second   line with");
  });

  it("finds match when quote contains newlines", () => {
    const text = "Start here and then continue to the end.";
    const span = findWhitespaceNormalizedSpan(text, "and\nthen\ncontinue");
    expect(span).not.toBeNull();
    expect(text.slice(span!.start, span!.end)).toBe("and then continue");
  });

  it("returns null for non-matching quote", () => {
    const text = "Some completely different text";
    const span = findWhitespaceNormalizedSpan(text, "nonexistent quote");
    expect(span).toBeNull();
  });
});
