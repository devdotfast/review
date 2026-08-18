import { compile } from "@mdx-js/mdx";
import { describe, expect, it } from "vitest";

import { reviewMdxOptions } from "./review-mdx-options";
import { reviewHelperImports } from "./review-mdx-transform";

describe("review MDX transform", () => {
  it("auto-imports software map backed diagram helpers", () => {
    expect(reviewHelperImports()).toContain("defineSoftwareActors");
    expect(reviewHelperImports()).toContain("defineSoftwareStores");
  });

  it("compiles GFM tables through the review MDX options", async () => {
    const compiled = String(
      await compile(
        [
          "| Area | Status |",
          "| --- | --- |",
          "| Tables | Rendered |",
          "",
        ].join("\n"),
        {
          ...reviewMdxOptions,
          jsx: true,
        },
      ),
    );

    expect(compiled).toContain('table: "table"');
    expect(compiled).toContain("<_components.table>");
    expect(compiled).toContain("<_components.th data-review-table");
    expect(compiled).toContain("Tables");
    expect(compiled).toContain('data-review-table="0"');
    expect(compiled).toContain('data-review-row="1"');
    expect(compiled).toContain('data-review-column="0"');
  });

  it("stamps rendered prose and code blocks with document-order AST indexes", async () => {
    const compiled = String(
      await compile(
        [
          "# Heading",
          "",
          "Paragraph.",
          "",
          "- List item",
          "",
          "```ts",
          "const value = 1;",
          "```",
        ].join("\n"),
        { ...reviewMdxOptions, jsx: true },
      ),
    );

    expect(compiled).toContain('data-review-block-index="0"');
    expect(compiled).toContain('data-review-block-tag="h1"');
    expect(compiled).toContain('data-review-block-tag="p"');
    expect(compiled).toContain('data-review-block-tag="li"');
    expect(compiled).toContain('data-review-block-tag="pre"');
  });
});
