import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  LEGACY_REVIEW_FIXTURES_ROOT,
  listLegacyReviewFixtures,
} from "../fixtures/legacy-reviews/legacy-review-fixture";
import { blockSchema, checkReferences, elements } from "../review-api/document";
import {
  reviewDocumentDataSchema,
  upgradeReviewDocumentJson,
} from "../review-document-data";
import { legacyDocumentToBlocks } from "./legacy-blocks";

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

  it("converts the canonical lens and degrades tutorial components", async () => {
    const { blocks, warnings, traces } = legacyDocumentToBlocks(
      await load("schema4-three-minute-tour"),
    );

    const json = JSON.stringify(blocks);
    expect(json).toContain('"type":"database_lens"');
    expect(json).toContain('"useCases"');
    expect(json).toContain('"type":"callout"');
    expect(warnings.some((warning) => /Tutorial/.test(warning))).toBe(true);
    expect(traces).toEqual([]);

    for (const block of blocks) blockSchema.parse(block);
    checkReferences(blocks);
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

  it("matches the committed goldens", async () => {
    for (const { name } of listLegacyReviewFixtures()) {
      const golden = parseJsonText(
        await readFile(
          path.join(
            LEGACY_REVIEW_FIXTURES_ROOT,
            `${name}.expected-blocks.json`,
          ),
          "utf8",
        ),
      );

      expect(legacyDocumentToBlocks(await load(name)).blocks).toEqual(golden);
    }
  });
});
