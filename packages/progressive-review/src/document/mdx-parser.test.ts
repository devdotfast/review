import { describe, expect, it } from "vitest";

import { parseReviewDocument } from "./mdx-parser";
import { reviewHelperImports } from "./review-mdx-transform";

describe("review MDX transform", () => {
  it("auto-imports software map backed diagram helpers", () => {
    expect(reviewHelperImports()).toContain("defineSoftwareActors");
    expect(reviewHelperImports()).toContain("defineSoftwareStores");
  });

  it("preserves GFM table cells, alignment, and block identities", async () => {
    const parsed = await parseReviewDocument(
      "# Heading\n\n| Left | Right |\n| :--- | ---: |\n| A | B |\n\nParagraph.\n\n```ts\nconst value = 1;\n```\n",
    );
    const text = JSON.stringify(parsed.body);
    for (const value of [
      "table",
      "th",
      "data-review-table",
      "data-review-row",
      "data-review-column",
      "data-review-block-index",
      "h1",
      "p",
      "pre",
    ])
      expect(text).toContain(value);
    expect(text).toContain('"name":"align","value":"left"');
    expect(text).toContain('"name":"align","value":"right"');
  });
});
