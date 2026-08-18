import { describe, expect, it } from "vitest";

import {
  maskReviewFrontmatter,
  splitReviewFrontmatter,
  stripReviewFrontmatter,
} from "./review-frontmatter";

describe("review frontmatter", () => {
  const document = "---\nlegacy: true\n---\n# Title\n";

  it("splits open, block, close, and body", () => {
    expect(splitReviewFrontmatter(document)).toEqual({
      open: "---\n",
      block: "legacy: true",
      close: "\n---\n",
      body: "# Title\n",
    });
  });

  it("handles CRLF fences", () => {
    const crlf = "---\r\nbase: main\r\n---\r\nbody\r\n";
    expect(splitReviewFrontmatter(crlf)).toEqual({
      open: "---\r\n",
      block: "base: main",
      close: "\r\n---\r\n",
      body: "body\r\n",
    });
    expect(stripReviewFrontmatter(crlf)).toBe("body\r\n");
  });

  it("returns null without an opening fence", () => {
    expect(splitReviewFrontmatter("# Title\n")).toBeNull();
    expect(stripReviewFrontmatter("# Title\n")).toBe("# Title\n");
  });

  it("returns null when the closing fence is missing", () => {
    const unclosed = "---\nbase: main\n# Title\n";
    expect(splitReviewFrontmatter(unclosed)).toBeNull();
    expect(maskReviewFrontmatter(unclosed)).toBe(unclosed);
  });

  it("masks frontmatter without shifting source locations", () => {
    const masked = maskReviewFrontmatter(document);
    expect(masked.length).toBe(document.length);
    expect(masked.split("\n").length).toBe(document.split("\n").length);
    expect(masked.endsWith("# Title\n")).toBe(true);
    expect(masked).not.toContain("legacy");
  });
});
