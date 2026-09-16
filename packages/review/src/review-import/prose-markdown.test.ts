import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  LEGACY_REVIEW_FIXTURES_ROOT,
  listLegacyReviewFixtures,
} from "../fixtures/legacy-reviews/legacy-review-fixture";
import { markdownNodes, parseMarkdown } from "../markdown";
import { sourceReferences } from "../review-api/document";
import {
  type ReviewNode,
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import { isProseNode, proseToMarkdown, sourceLink } from "./prose-markdown";

const el = (
  tag: string,
  children: ReviewNode[] = [],
  props: Record<string, string | number | boolean> = {},
): ReviewNode => ({ type: "element", tag, props, children }) as ReviewNode;

const text = (value: string): ReviewNode => ({ type: "text", value });

describe("proseToMarkdown", () => {
  it("renders headings, paragraphs and inline marks", () => {
    expect(
      proseToMarkdown([
        el("h1", [text("Title")]),
        el("p", [
          text("Hello "),
          el("strong", [text("bold")]),
          text(" and "),
          el("em", [text("soft")]),
          text(" "),
          el("code", [text("x`y")]),
        ]),
      ]),
    ).toBe("# Title\n\nHello **bold** and *soft* ``x`y``\n");
  });

  it("turns inline AnchorLink components into review-source links", () => {
    const anchor = {
      __kind: "db-anchor-ref",
      id: "a",
      title: "Queue",
      peek: { side: "head", file: "src/order.ts", fromLine: 3, toLine: 9 },
    };

    expect(
      proseToMarkdown([
        el("p", [
          text("See "),
          {
            type: "component",
            name: "AnchorLink",
            props: { anchor },
            children: [text("the queue")],
          } as ReviewNode,
        ]),
      ]),
    ).toBe("See [the queue](review-source:head/src/order.ts#L3-L9)\n");
    expect(
      sourceLink({ side: "base", file: "a b.ts", fromLine: 1, toLine: 1 }),
    ).toBe("review-source:base/a%20b.ts#L1-L1");
  });

  it("renders task lists, nested lists and ordered lists", () => {
    expect(
      proseToMarkdown([
        el("ul", [
          el("li", [
            el("input", [], {
              type: "checkbox",
              checked: true,
              disabled: true,
            }),
            text(" done"),
          ]),
          el("li", [text("todo"), el("ul", [el("li", [text("nested")])])]),
        ]),
        el("ol", [el("li", [text("first")]), el("li", [text("second")])]),
      ]),
    ).toBe("- [x] done\n- todo\n  - nested\n\n1. first\n1. second\n");
  });

  it("renders tables with alignment", () => {
    expect(
      proseToMarkdown([
        el("table", [
          el("thead", [
            el("tr", [
              el("th", [text("Name")]),
              el("th", [text("Qty")], { align: "right" }),
            ]),
          ]),
          el("tbody", [
            el("tr", [
              el("td", [text("a|b")]),
              el("td", [text("2")], { align: "right" }),
            ]),
          ]),
        ]),
      ]),
    ).toBe("| Name | Qty |\n| --- | --: |\n| a\\|b | 2 |\n");
  });

  it("renders fenced code with a language", () => {
    expect(
      proseToMarkdown([
        el("pre", [
          el("code", [text("const a = `x`;\n")], { className: "language-ts" }),
        ]),
      ]),
    ).toBe("```ts\nconst a = `x`;\n```\n");
  });

  it("renders footnotes as GFM footnotes", () => {
    expect(
      proseToMarkdown([
        el("p", [
          text("A note"),
          el("sup", [
            el("a", [text("1")], {
              href: "#user-content-fn-1",
              id: "user-content-fnref-1",
              "data-footnote-ref": true,
            }),
          ]),
          text("."),
        ]),
        el(
          "section",
          [
            el("h2", [text("Footnotes")], { id: "footnote-label" }),
            el("ol", [
              el(
                "li",
                [
                  el("p", [
                    text("Native pipeline footnote. "),
                    el("a", [text("↩")], {
                      href: "#user-content-fnref-1",
                      "data-footnote-backref": true,
                    }),
                  ]),
                ],
                { id: "user-content-fn-1" },
              ),
            ]),
          ],
          { "data-footnotes": true },
        ),
      ]),
    ).toBe("A note[^1].\n\n[^1]: Native pipeline footnote.\n");
  });

  it("degrades kbd and blockquotes", () => {
    expect(
      proseToMarkdown([
        el("blockquote", [
          el("p", [text("Press "), el("kbd", [text("Enter")])]),
        ]),
      ]),
    ).toBe("> Press `Enter`\n");
  });

  it("escapes markdown syntax in text", () => {
    expect(
      proseToMarkdown([el("p", [text("1. not a list *nor* [link]")])]),
    ).toBe("1\\. not a list \\*nor\\* \\[link\\]\n");
  });

  it("round-trips every fixture's prose through the store's Markdown parser", async () => {
    for (const { name } of listLegacyReviewFixtures()) {
      const document = reviewDocumentDataSchema.parse(
        upgradeReviewDocumentJson(
          parseJsonText(
            await readFile(
              path.join(
                LEGACY_REVIEW_FIXTURES_ROOT,
                `${name}.expected-document.json`,
              ),
              "utf8",
            ),
          ),
        ),
      );

      for (const run of proseRuns(document.body)) {
        const markdown = proseToMarkdown(run);
        const tree = parseMarkdown(markdown);

        expect(
          [...markdownNodes(tree)].filter((node) => node.type === "html"),
          `${name}: ${markdown}`,
        ).toEqual([]);

        expect(
          sourceReferences([{ type: "markdown", markdown, id: "m" }]),
          `${name}: ${markdown}`,
        ).toHaveLength(peekableAnchorLinks(run));
      }
    }
  });
});

function peekableAnchorLinks(nodes: ReviewNode[]): number {
  let count = 0;

  for (const node of nodes) {
    if (
      node.type === "component" &&
      node.name === "AnchorLink" &&
      (node.props as { anchor: { peek?: unknown } }).anchor.peek
    )
      count += 1;

    if (node.type !== "text") count += peekableAnchorLinks(node.children);
  }

  return count;
}

/** Maximal runs of prose nodes at every nesting level, mirroring the converter. */
function proseRuns(nodes: ReviewNode[]): ReviewNode[][] {
  const runs: ReviewNode[][] = [];
  let current: ReviewNode[] = [];

  for (const node of nodes) {
    if (isProseNode(node)) {
      current.push(node);
      continue;
    }

    if (current.length) runs.push(current);
    current = [];

    if (node.type === "component") runs.push(...proseRuns(node.children));
  }

  if (current.length) runs.push(current);

  return runs;
}
