import { expect, it } from "vitest";

import { selectSource } from "../lens-selection.js";
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

const range = {
  side: "head",
  file: "src/save.ts",
  fromLine: 3,
  toLine: 9,
} as const;

it("marks every source that renders as a peek, but not prose links", () => {
  const references = sourceReferences([
    { type: "code_peek", id: "peek-1", source: selectSource(range) },
    {
      type: "markdown",
      id: "n-2",
      markdown: "[save](review-source:head/src/save.ts#L3-L9)",
    },
    {
      type: "sequence",
      id: "seq-3",
      title: "Save",
      actors: { a: "App", s: "Server" },
      steps: [
        {
          type: "step",
          id: "step-4",
          from: "a",
          to: "s",
          label: "save",
          style: "call",
          source: selectSource(range),
        },
        {
          type: "step",
          id: "step-5",
          from: "s",
          to: "a",
          label: "ok",
          style: "return",
          explanation: "done",
        },
      ],
    },
    {
      type: "call_stack_diff",
      id: "stack-6",
      title: "Save path",
      base: [],
      head: [
        {
          id: "frame-7",
          key: "save",
          label: "save",
          source: selectSource(range),
        },
      ],
    },
    {
      type: "database_lens",
      id: "lens-8",
      title: "Saves",
      actors: { s: "Server" },
      stores: {
        db: {
          label: "DB",
          storage: "relational",
          collections: {
            saves: {
              label: "Saves",
              fields: { id: { label: "id", dataType: "text" } },
            },
          },
        },
      },
      useCases: [
        {
          id: "case-9",
          label: "Save",
          operations: [
            {
              id: "op-10",
              kind: "write",
              store: "db",
              collection: "saves",
              actor: "s",
              label: "insert",
              source: selectSource(range),
            },
          ],
        },
      ],
    },
  ]);

  expect(references.map(({ id, peek }) => [id, peek])).toEqual([
    ["peek-1", true],
    ["n-2:review-source:head/src/save.ts#L3-L9", undefined],
    ["step-4", true],
    ["frame-7", true],
    ["op-10", true],
  ]);
});

it("resolves a block's links at the block's own pins, and only where those pins allow", () => {
  const pins = { repositoryId: "repo-b", head: "b".repeat(40) };

  const [own] = sourceReferences([
    {
      type: "markdown",
      id: "n-2",
      markdown: "[save](review-source:head/src/save.ts#L2-L4)",
      pins,
    },
  ]);

  expect(own!.source).toEqual({
    side: "head",
    file: "src/save.ts",
    fromLine: 2,
    toLine: 4,
    pins,
  });
  expect(() =>
    sourceReferences([
      {
        type: "markdown",
        id: "n-3",
        markdown: "[old](review-source:base/src/save.ts#L2)",
        pins,
      },
    ]),
  ).toThrow(/base-side source needs base pins/);
});

for (const href of [
  "packages/review/src/sharing/cli.ts#L76-L80",
  ".github/workflows/review-author.yml",
  "./src/save.ts#L2",
  "../src/save.ts#L2",
  "/src/save.ts#L2",
  "file:///Users/author/repo/src/save.ts#L2",
  "vscode://file/src/save.ts:2",
  "//example.com/src/save.ts",
  "javascript:alert(1)",
]) {
  it(`rejects unsupported Markdown destination ${href} with authoring guidance`, () => {
    expect(() => sources(`[file](<${href}>)`)).toThrow(
      "Use [label](review-source:head/path#L10-L24)",
    );
    expect(() => sources(`[file][ref]\n\n[ref]: <${href}>`)).toThrow(
      "Use [label](review-source:head/path#L10-L24)",
    );
    expect(
      sourceReferences(
        [{ type: "markdown", id: "old", markdown: `[file](<${href}>)` }],
        { tolerant: true },
      ),
    ).toEqual([]);
  });
}

it("preserves external links, anchors, and literal link examples", () => {
  expect(
    sources(
      "[site](https://example.com/a) [local web](http://localhost/a) [mail](mailto:a@example.com) [section](#details) `[file](src/a.ts)`\n\n```md\n[file](src/a.ts)\n```",
    ),
  ).toEqual([]);
});
