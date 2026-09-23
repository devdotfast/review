import { expect, it } from "vitest";

import { migrateDiffSelections } from "./diff-selection-migration";
import { diffSelectionSchema, resolveDiffSelection } from "./lens-selection";

it("migrates retained peeks and lens endpoints without altering IDs or unrelated line data", () => {
  const old = {
    id: "frame",
    source: { file: "a.ts", side: "head", fromLine: 1, toLine: 2 },
    sourceRanges: [{ file: "a.ts", fromLine: 1, toLine: 2 }],
  };

  const migrated = migrateDiffSelections(old) as typeof old & {
    source: unknown;
  };

  const selection = diffSelectionSchema.parse(migrated.source);
  expect(migrated.id).toBe(old.id);
  expect(migrated.sourceRanges).toEqual(old.sourceRanges);
  expect(old.source).toHaveProperty("fromLine", 1);
  expect(
    resolveDiffSelection(
      selection,
      [
        [0, 0],
        [1, null],
        [2, 1],
      ],
      { path: "a.ts" },
    ),
  ).toEqual([
    { file: "a.ts", side: "base", fromLine: 1, toLine: 3 },
    { file: "a.ts", side: "head", fromLine: 1, toLine: 2 },
  ]);
  expect(migrateDiffSelections(migrated)).toEqual(migrated);
});

it("preserves deletion-only and insertion-only endpoint boundaries during migration", () => {
  const migrated = migrateDiffSelections({
    source: {
      file: "a.ts",
      start: { baseLine: 2, headLine: null },
      end: { baseLine: null, headLine: 3 },
    },
  }) as { source: unknown };

  const selection = diffSelectionSchema.parse(migrated.source);
  expect(selection.start).toEqual({ side: "base", line: 2 });
  expect(selection.end).toEqual({ side: "head", line: 3 });
  expect(
    resolveDiffSelection(
      selection,
      [
        [0, 0],
        [1, null],
        [null, 1],
        [null, 2],
        [2, 3],
      ],
      { path: "a.ts" },
    ),
  ).toEqual([
    { file: "a.ts", side: "base", fromLine: 2, toLine: 2 },
    { file: "a.ts", side: "head", fromLine: 2, toLine: 3 },
  ]);
});
