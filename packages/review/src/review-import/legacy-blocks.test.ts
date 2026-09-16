import { readFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
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
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import { legacyDocumentToBlocks } from "./legacy-blocks";

/** A sealed document whose body is `body`, for the nesting cases no fixture has. */
const documentOf = (body: JsonValue[]) =>
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

const sequence = (title: string): JsonValue => ({
  type: "component",
  name: "SequenceDiagram",
  props: {
    id: title,
    title,
    actors: { caller: "Caller", callee: "Callee" },
    steps: [
      { from: "caller", to: "callee", label: "call", explanation: "why" },
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
        {
          type: "element",
          tag: "p",
          props: {},
          children: [
            { type: "text", value: "Two flows: " },
            sequence("First flow"),
            { type: "text", value: " and " },
            sequence("Second flow"),
          ],
        },
        {
          type: "element",
          tag: "p",
          props: {},
          children: [{ type: "text", value: "After." }],
        },
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
      "SequenceDiagram inside p was moved after it",
      "SequenceDiagram inside p was moved after it",
    ]);

    for (const block of blocks) blockSchema.parse(block);
  });

  it("hoists a diagram out of a list item, leaving the item empty", () => {
    const { blocks, warnings } = legacyDocumentToBlocks(
      documentOf([
        {
          type: "element",
          tag: "ul",
          props: {},
          children: [
            {
              type: "element",
              tag: "li",
              props: {},
              children: [sequence("Sole child")],
            },
          ],
        },
      ]),
    );

    expect(blocks).toEqual([
      { type: "markdown", markdown: "-\n" },
      expect.objectContaining({ type: "sequence", title: "Sole child" }),
    ]);
    expect(warnings).toEqual(["SequenceDiagram inside li was moved after it"]);
  });

  it("hoists a diagram out of a blockquote", () => {
    const { blocks, warnings } = legacyDocumentToBlocks(
      documentOf([
        {
          type: "element",
          tag: "blockquote",
          props: {},
          children: [
            {
              type: "element",
              tag: "p",
              props: {},
              children: [{ type: "text", value: "Quoted." }],
            },
            sequence("Quoted flow"),
          ],
        },
      ]),
    );

    expect(blocks).toEqual([
      { type: "markdown", markdown: "> Quoted.\n" },
      expect.objectContaining({ type: "sequence", title: "Quoted flow" }),
    ]);
    expect(warnings).toEqual([
      "SequenceDiagram inside blockquote was moved after it",
    ]);
  });

  it("registers a footnote's trace quote once, whatever cites the footnote", () => {
    const reference = () => ({
      type: "element",
      tag: "sup",
      props: {},
      children: [
        {
          type: "element",
          tag: "a",
          props: {
            href: "#user-content-fn-1",
            id: "user-content-fnref-1",
            "data-footnote-ref": "true",
          },
          children: [{ type: "text", value: "1" }],
        },
      ],
    });

    const { blocks, traces, warnings } = legacyDocumentToBlocks(
      documentOf([
        {
          type: "element",
          tag: "p",
          props: {},
          children: [{ type: "text", value: "First" }, reference()],
        },
        {
          type: "component",
          name: "ReviewSection",
          props: { title: "Detail" },
          children: [
            {
              type: "element",
              tag: "p",
              props: {},
              children: [{ type: "text", value: "Second" }, reference()],
            },
          ],
        },
        {
          type: "element",
          tag: "section",
          props: { "data-footnotes": "true" },
          children: [
            {
              type: "element",
              tag: "ol",
              props: {},
              children: [
                {
                  type: "element",
                  tag: "li",
                  props: { id: "user-content-fn-1" },
                  children: [
                    {
                      type: "element",
                      tag: "p",
                      props: {},
                      children: [
                        { type: "text", value: "The agent " },
                        {
                          type: "component",
                          name: "TraceQuote",
                          props: { sessionId: "s1", event: 4 },
                          children: [{ type: "text", value: "said so" }],
                        },
                        { type: "text", value: "." },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );

    const definition =
      "[^1]: The agent [said so](review-trace:trace-placeholder-1#4).";

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
