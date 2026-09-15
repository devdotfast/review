import { describe, expect, it } from "vitest";

import { reviewHelperImports } from "./authoring-environment";
import { parseReviewDocument } from "./mdx-parser";
import { DocumentParseError } from "./syntax";

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

describe("document headings", () => {
  it.each([
    ["# **Bold title**", "Bold title"],
    ["# [Linked *title*](https://example.com)", "Linked title"],
    [
      "# Text `code` and **bold [link](https://example.com)**",
      "Text code and bold link",
    ],
    ["# ![Architecture](diagram.png)", "Architecture"],
    ["# {dynamicTitle}", "review"],
    ["No heading", "review"],
  ])("extracts static title text from %s", async (source, title) => {
    expect((await parseReviewDocument(source)).title).toBe(title);
  });

  it("uses the same rich text for collapsed section labels", async () => {
    const parsed = await parseReviewDocument(
      "# Review\n\n## [Section **label**](https://example.com) [collapsed]\n\nContent.\n",
    );

    const section = parsed.body.find(
      (node) => node.kind === "element" && node.name === "ReviewSection",
    );

    expect(section).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({
          kind: "literal",
          name: "title",
          value: "Section label",
        }),
        expect.objectContaining({
          kind: "literal",
          name: "defaultCollapsed",
          value: true,
        }),
      ]),
    });
  });
});

describe("authored expression positions", () => {
  it("positions repeated short expressions inside their own attributes", async () => {
    const source = "<SequenceDiagram label={a} messages={a} />";
    const parsed = await parseReviewDocument(source);
    expect(parsed.expressions).toEqual([
      {
        value: "a",
        span: {
          start: source.indexOf("{a}") + 1,
          end: source.indexOf("{a}") + 2,
        },
      },
      {
        value: "a",
        span: {
          start: source.lastIndexOf("{a}") + 1,
          end: source.lastIndexOf("{a}") + 2,
        },
      },
    ]);
  });

  it("retains original UTF-16 positions around multiline CRLF expressions", async () => {
    const source = "# 🌲\r\n\r\n<ReviewSection title={\r\n  title\r\n} />";
    const [expression] = (await parseReviewDocument(source)).expressions;
    expect(expression.span).toEqual({
      start: source.indexOf("{") + 1,
      end: source.indexOf("}"),
    });
    expect(expression.value.trim()).toBe("title");
  });

  it.each([
    "[anchors.missing](anchors.missing)",
    '[anchors.missing](anchors.missing "anchors.missing")',
    "[**anchors.missing**](<anchors.missing>)",
    "[](anchors.missing)",
    "[Label](\n  anchors.missing\n)",
  ])(
    "positions an anchor expression at the destination in %s",
    async (source) => {
      const parsed = await parseReviewDocument(source);
      const start = source.indexOf("anchors.missing", source.indexOf("](") + 2);
      expect(parsed.expressions).toEqual([
        {
          value: "anchors.missing",
          span: { start, end: start + "anchors.missing".length },
        },
      ]);
    },
  );
});

describe("declared software models", () => {
  it("keeps exported model declarations in source order without preferring imported models", async () => {
    const parsed = await parseReviewDocument(
      [
        'import { importedModel } from "./data.ts";',
        'export const first = defineSoftwareModel({ systems: { first: { label: "First" } } });',
        "export const alias = importedModel;",
        "",
        "# Models",
        "",
        'export const second: Model = defineSoftwareModel({ systems: { second: { label: "Second" } } }) satisfies Model;',
        "export const third = defineSoftwareModel({}) as Model, fourth = defineSoftwareModel({})!;",
      ].join("\n"),
    );

    expect(parsed.declaredModelNames).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
    expect(parsed.bindings).toContain("importedModel");
    expect(parsed.bindings).toContain("alias");
  });
});

describe("author parse diagnostics", () => {
  it("preserves the location of malformed JSX", async () => {
    await expect(
      parseReviewDocument("# Review\n\n<CodePeek anchor={"),
    ).rejects.toMatchObject({ name: "DocumentParseError", line: 3 });
  });

  it("recognizes located author errors from the anchor-link transform", async () => {
    const result = parseReviewDocument("# Review\n\n[Wrong](anchors.bad-name)");
    await expect(result).rejects.toBeInstanceOf(DocumentParseError);
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining("Review anchor links must use"),
      line: 3,
      column: 1,
    });
  });
});
