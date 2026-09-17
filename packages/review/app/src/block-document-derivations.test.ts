import { describe, expect, it } from "vitest";

import { blockSectionSummary } from "./block-document-derivations";

describe("blockSectionSummary", () => {
  it("counts diagrams and source peeks through nested sections and callouts", () => {
    expect(
      blockSectionSummary([
        {
          type: "section",
          title: "Nested",
          children: [
            { type: "sequence", title: "Flow", actors: {}, steps: [] },
            {
              type: "database_lens",
              title: "Storage",
              actors: {},
              stores: {},
              useCases: [],
            },
            {
              type: "callout",
              tone: "info",
              children: [
                { type: "call_stack_diff", title: "Stack", base: [], head: [] },
                { type: "software_map", mapVersionId: "map-1" },
                {
                  type: "code_peek",
                  source: {
                    side: "head",
                    file: "x.ts",
                    fromLine: 1,
                    toLine: 2,
                  },
                },
                { type: "markdown", markdown: "One.\n\nTwo." },
              ],
            },
          ],
        },
      ]),
    ).toEqual({ diagrams: 4, codeRefs: 1, paragraphs: 2 });
  });

  it("counts rendered source links, including references, without counting code examples", () => {
    expect(
      blockSectionSummary([
        {
          type: "markdown",
          markdown: [
            "## Heading",
            "",
            "One [peek](review-source:head/x.ts#L1-L2) and [another][source].",
            "",
            "`[literal](review-source:head/x.ts#L1)` and [external](https://example.com).",
            "",
            "```md",
            "[example](review-source:head/x.ts#L1)",
            "```",
            "",
            "[source]: review-source:base/x.ts#L1",
          ].join("\n"),
        },
      ]),
    ).toEqual({ diagrams: 0, codeRefs: 2, paragraphs: 2 });
  });
});
