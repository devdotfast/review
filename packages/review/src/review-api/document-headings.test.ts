import { describe, expect, it } from "vitest";

import { documentHeadings } from "./document-headings.js";
import type { Block } from "./document.js";

describe("documentHeadings", () => {
  it("slugs the whole heading text, inline code and links included", () => {
    const block: Block = {
      id: "b1",
      type: "markdown",
      markdown: "# Title\n\n## The `store` and [its home](https://x.test)\n",
    };

    expect(documentHeadings([block])).toEqual([
      {
        id: "the-store-and-its-home",
        text: "The store and its home",
        level: "h2",
        block,
        index: 1,
      },
    ]);
  });

  it("falls back to `section` when a heading slugs to nothing", () => {
    const block: Block = { id: "b1", type: "markdown", markdown: "### ?!\n" };

    expect(documentHeadings([block])).toMatchObject([
      { id: "section", level: "h3" },
    ]);
  });

  it("indexes past a footnote definition, as the renderer's body does", () => {
    const block: Block = {
      id: "b1",
      type: "markdown",
      markdown: "Intro[^1]\n\n[^1]: note\n\n## Heading\n",
    };

    expect(documentHeadings([block])).toMatchObject([
      { id: "heading", index: 1 },
    ]);
  });

  it("numbers a repeated slug in document order across blocks", () => {
    const nested: Block = {
      id: "b2",
      type: "markdown",
      markdown: "## Details\n\n#### Details\n",
    };

    const blocks: Block[] = [
      { id: "b1", type: "section", title: "Details", children: [nested] },
    ];

    expect(documentHeadings(blocks)).toMatchObject([
      { id: "details", text: "Details", level: "h2", block: blocks[0] },
      { id: "details-2", text: "Details", level: "h2", block: nested },
    ]);
  });
});
