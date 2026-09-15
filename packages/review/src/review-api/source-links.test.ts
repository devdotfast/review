import { expect, it } from "vitest";

import { sourceReferences } from "./document.js";

const sources = (markdown: string) =>
  sourceReferences([{ type: "markdown", id: "n-1", markdown }]);

it("finds actual source links in prose, reference links and tables, not code or unused definitions", () => {
  const references = sources(
    [
      "See [**save**](review-source:head/src/save.ts#L2-L4).",
      "",
      "| Before | Why |",
      "| --- | --- |",
      "| [old][source] | unchanged |",
      "",
      "[source]: review-source:base/src/a%20b.ts#L1",
      "[unused]: review-source:invalid",
      "",
      "`[example](review-source:invalid)`",
      "```md",
      "[example](review-source:invalid)",
      "```",
      "[external](https://example.com/src/save.ts#L2)",
    ].join("\n"),
  );

  expect(references.map((item) => item.source)).toEqual([
    { side: "head", file: "src/save.ts", fromLine: 2, toLine: 4 },
    { side: "base", file: "src/a b.ts", fromLine: 1, toLine: 1 },
  ]);
  expect(
    sources("[new label](review-source:head/src/save.ts#L2-L4)")[0]!.id,
  ).toBe(references[0]!.id);
});

it("rejects malformed source destinations instead of saving a broken peek", () => {
  for (const href of [
    "review-source:main/file.ts#L1",
    "review-source:head/file.ts",
    "review-source:head/file.ts#L0",
    "review-source:head/file.ts#L4-L2",
    "review-source:head/%ZZ.ts#L1",
  ])
    expect(() => sources(`[bad](${href})`)).toThrow(Error);
});
