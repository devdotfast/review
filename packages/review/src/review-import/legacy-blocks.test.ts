import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  LEGACY_REVIEW_FIXTURES_ROOT,
  listLegacyReviewFixtures,
} from "../fixtures/legacy-reviews/legacy-review-fixture";
import {
  blockSchema,
  checkReferences,
  elements,
  resourceReferences,
} from "../review-api/document";
import {
  type ReviewNode,
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import { el, footnoteTraceQuoteSection, text } from "./import-test-utils";
import { legacyDocumentToBlocks } from "./legacy-blocks";

/** A sealed document whose body is `body`, for the nesting cases no fixture has. */
const documentOf = (body: ReviewNode[]) =>
  reviewDocumentDataSchema.parse({
    format: "review-document/1",
    title: "T",
    routePath: "/",
    sourcePath: "review.mdx",
    anchors: {},
    anchorContents: {},
    softwareModels: [],
    body,
  });

const sequence = (title: string): ReviewNode => ({
  type: "component",
  name: "SequenceDiagram",
  props: {
    id: title,
    title,
    actors: { caller: "Caller", callee: "Callee" },
    steps: [
      {
        type: "step",
        style: "call",
        from: "caller",
        to: "callee",
        label: "call",
        explanation: "why",
      },
    ],
  },
  children: [],
});

const load = async (name: string) =>
  reviewDocumentDataSchema.parse(
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

describe("legacyDocumentToBlocks", () => {
  it("maps sections, prose, links and diagrams", async () => {
    const { blocks, warnings } = legacyDocumentToBlocks(
      await load("schema4-opencode-agentserver"),
    );

    expect(warnings).toEqual([]);
    expect(blocks[0]?.type).toBe("markdown");
    expect(
      blocks[0]?.type === "markdown" && blocks[0].markdown.startsWith("# "),
    ).toBe(true);
    expect(blocks.filter((block) => block.type === "section")).toHaveLength(4);
    expect(JSON.stringify(blocks)).toContain('"type":"sequence"');
    expect(JSON.stringify(blocks)).toContain("review-source:head/");

    for (const block of blocks) blockSchema.parse(block);
    checkReferences(blocks);
  });

  it("never emits element ids", async () => {
    const stray: string[] = [];

    for (const { name } of listLegacyReviewFixtures())
      for (const element of elements(
        legacyDocumentToBlocks(await load(name)).blocks,
      )) {
        if (element.id !== undefined) stray.push(`${name}:${element.type}`);

        if (element.type === "call_stack_diff")
          for (const frame of [...element.base, ...element.head])
            if (frame.id !== undefined) stray.push(`${name}:frame`);

        if (element.type === "database_lens")
          for (const useCase of element.useCases) {
            if (useCase.id !== undefined) stray.push(`${name}:case`);

            for (const operation of useCase.operations)
              if (operation.id !== undefined) stray.push(`${name}:operation`);
          }
      }

    expect(stray).toEqual([]);
  });

  it("emits a trace request per TraceQuote", () => {
    const document = reviewDocumentDataSchema.parse({
      format: "review-document/1",
      title: "T",
      routePath: "/",
      sourcePath: "review.mdx",
      anchors: {},
      anchorContents: {},
      softwareModels: [],
      body: [
        {
          type: "component",
          name: "TraceQuote",
          props: { sessionId: "s1", event: 4 },
          children: [{ type: "text", value: "quoted words" }],
        },
      ],
    });

    const { blocks, traces } = legacyDocumentToBlocks(document);

    expect(traces).toEqual([
      {
        sessionId: "s1",
        trace: undefined,
        eventIndex: 4,
        quote: "quoted words",
        placeholder: "trace-placeholder-1",
      },
    ]);
    expect(blocks[0]).toEqual({
      type: "trace_quote",
      traceId: "trace-placeholder-1",
      eventId: "4",
      text: "quoted words",
    });
  });

  it("keeps nested quotes in their paragraph and list with trace references", async () => {
    const document = await load("schema4-opencode-agentserver");

    const quote = {
      type: "component",
      name: "TraceQuote",
      props: { sessionId: "s1", event: 4 },
      children: [{ type: "text", value: "quoted [words]\nnext line" }],
    } as const;

    document.body = reviewDocumentDataSchema.parse({
      ...document,
      body: [
        {
          type: "element",
          tag: "p",
          props: {},
          children: [
            { type: "text", value: "Before " },
            quote,
            { type: "text", value: " after." },
          ],
        },
        {
          type: "element",
          tag: "ol",
          props: { start: 3 },
          children: [
            { type: "element", tag: "li", props: {}, children: [quote] },
          ],
        },
      ],
    }).body;
    const { blocks, traces, warnings } = legacyDocumentToBlocks(document);
    expect(warnings).toEqual([]);
    expect(traces).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "markdown",
      markdown: expect.stringContaining("Before [quoted"),
    });
    expect(JSON.stringify(blocks)).toContain("3. ");
    expect(
      resourceReferences(blocks).map(
        (quote) => quote.type === "trace_quote" && quote.text,
      ),
    ).toEqual(["quoted [words]\nnext line", "quoted [words]\nnext line"]);
  });

  it("hoists diagrams nested in prose to just after that prose", () => {
    const { blocks, warnings } = legacyDocumentToBlocks(
      documentOf([
        el("p", [
          text("Two flows: "),
          sequence("First flow"),
          text(" and "),
          sequence("Second flow"),
        ]),
        el("p", [text("After.")]),
      ]),
    );

    expect(blocks.map((block) => block.type)).toEqual([
      "markdown",
      "sequence",
      "sequence",
      "markdown",
    ]);
    expect(blocks[0]).toMatchObject({
      markdown: expect.stringContaining("Two flows:"),
    });
    expect(blocks[1]).toMatchObject({ title: "First flow" });
    expect(blocks[2]).toMatchObject({ title: "Second flow" });
    expect(blocks[3]).toMatchObject({ markdown: "After.\n" });
    expect(warnings).toEqual([
      "SequenceDiagram was moved after the enclosing prose",
      "SequenceDiagram was moved after the enclosing prose",
    ]);

    for (const block of blocks) blockSchema.parse(block);
  });

  it.each([
    {
      container: "a paragraph",
      node: el("p", [text("Shown here: "), sequence("Flow")]),
      markdown: "Shown here:\n",
    },
    {
      container: "a list item",
      node: el("ul", [el("li", [sequence("Flow")])]),
      markdown: "-\n",
    },
    {
      container: "a blockquote",
      node: el("blockquote", [el("p", [text("Quoted.")]), sequence("Flow")]),
      markdown: "> Quoted.\n",
    },
  ])("hoists a diagram out of $container", ({ node, markdown }) => {
    const { blocks, warnings } = legacyDocumentToBlocks(documentOf([node]));

    expect(blocks).toEqual([
      { type: "markdown", markdown },
      expect.objectContaining({ type: "sequence", title: "Flow" }),
    ]);
    expect(warnings).toEqual([
      "SequenceDiagram was moved after the enclosing prose",
    ]);
  });

  it("registers a footnote's trace quote once, whatever cites the footnote", () => {
    const reference = () =>
      el("sup", [
        el("a", [text("1")], {
          href: "#user-content-fn-1",
          id: "user-content-fnref-1",
          "data-footnote-ref": "true",
        }),
      ]);

    const { blocks, traces, warnings } = legacyDocumentToBlocks(
      documentOf([
        el("p", [text("First"), reference()]),
        {
          type: "component",
          name: "ReviewSection",
          props: { title: "Detail" },
          children: [el("p", [text("Second"), reference()])],
        } as ReviewNode,
        footnoteTraceQuoteSection("1"),
      ]),
    );

    const definition =
      "[^1]: The agent [agent said so](review-trace:trace-placeholder-1#2).";

    expect(traces).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(blocks.map((block) => block.type)).toEqual(["markdown", "section"]);
    expect(blocks[0]).toMatchObject({
      markdown: expect.stringContaining(definition),
    });
    expect(blocks[1]).toMatchObject({
      children: [{ markdown: expect.stringContaining(definition) }],
    });
  });
});
