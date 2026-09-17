import { expect, it } from "vitest";

import { rewriteSourceLinks } from "./document.js";
import { mapSourceRange } from "./source-ranges.js";

it.each([
  ["-- SQL comment\nselect 1;\n", "select 1;\n", 2, 1],
  ["---\nvalue: 1\n", "value: 1\n", 2, 1],
  ["select 1;\n", "++ content\nselect 1;\n", 1, 2],
])(
  "maps unchanged lines past header-like hunk content",
  async (before, after, fromLine, expected) => {
    expect(
      await mapSourceRange(
        { side: "head", file: "source.txt", fromLine, toLine: fromLine },
        before,
        after,
      ),
    ).toMatchObject({ fromLine: expected, toLine: expected });
  },
);

it("rewrites parsed destinations simultaneously without changing prose, code, or titles", () => {
  const one = "review-source:head/a.ts#L1",
    two = "review-source:head/a.ts#L2";

  const markdown = `[${one}](${one} "${one}") [two](${two})\n\n\`${one}\`\n\n[ref][r]\n\n[r]: ${one}\n`;
  expect(
    rewriteSourceLinks(
      markdown,
      new Map([
        [one, two],
        [two, "review-source:head/a.ts#L3"],
      ]),
    ),
  ).toBe(
    `[${one}](${two} "${one}") [two](review-source:head/a.ts#L3)\n\n\`${one}\`\n\n[ref][r]\n\n[r]: ${two}\n`,
  );
});
