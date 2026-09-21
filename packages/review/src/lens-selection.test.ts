import { expect, it } from "vitest";

import { diffSelectionSchema, resolveDiffSelection } from "./lens-selection.js";
import { textualRows } from "./review-api/lens-alignment.js";
import {
  type CoverageFile,
  coverageProgress,
  scopedCoverage,
  emptyCoverage,
} from "./viewed-coverage.js";

const file = { path: "new.ts", previousPath: "old.ts" };
// A deletion lies between two head lines, followed by an insertion-only row.
const rows = [
  [0, 0],
  [1, null],
  [2, 1],
  [null, 2],
  [3, 3],
  [4, 4],
] as const;

it("includes interior deletion rows when selecting by head endpoints, but excludes surrounding context", () => {
  const scope = resolveDiffSelection(
    {
      file: "new.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 3 },
    },
    rows,
    file,
  );
  expect(scope).toEqual([
    { file: "old.ts", side: "base", fromLine: 1, toLine: 3 },
    { file: "new.ts", side: "head", fromLine: 1, toLine: 3 },
  ]);
  const coverage: CoverageFile = {
    ...file,
    fingerprint: "v1",
    changed: {
      base: [
        [1, 2],
        [4, 5],
      ],
      head: [
        [2, 3],
        [4, 5],
      ],
    },
    viewed: emptyCoverage(),
  };
  expect(coverageProgress([coverage], scope).total).toEqual({
    additions: 1,
    deletions: 1,
  });
  const viewed = scopedCoverage(coverage, scope);
  expect(coverageProgress([{ ...coverage, viewed }], scope).state).toBe(
    "viewed",
  );
  expect(coverageProgress([{ ...coverage, viewed }]).remaining).toEqual({
    additions: 1,
    deletions: 1,
  });
});

it("accepts an interval starting on a deletion and ending on an insertion", () => {
  const selection = diffSelectionSchema.parse({
    file: "new.ts",
    start: { side: "base", line: 2 },
    end: { side: "head", line: 3 },
  });
  expect(resolveDiffSelection(selection, rows, file)).toEqual([
    { file: "old.ts", side: "base", fromLine: 2, toLine: 3 },
    { file: "new.ts", side: "head", fromLine: 2, toLine: 3 },
  ]);
});

it("does not widen a one-row selection to adjacent one-sided changes", () => {
  expect(
    resolveDiffSelection(
      {
        file: "new.ts",
        start: { side: "head", line: 2 },
        end: { side: "head", line: 2 },
      },
      rows,
      file,
    ),
  ).toEqual([
    { file: "old.ts", side: "base", fromLine: 3, toLine: 3 },
    { file: "new.ts", side: "head", fromLine: 2, toLine: 2 },
  ]);
});

it("rejects stale or reversed endpoints instead of inventing correspondence", () => {
  for (const selection of [
    {
      file: "new.ts",
      start: { side: "head" as const, line: 99 },
      end: { side: "head" as const, line: 2 },
    },
    {
      file: "new.ts",
      start: { side: "base" as const, line: 4 },
      end: { side: "head" as const, line: 1 },
    },
  ])
    expect(() => resolveDiffSelection(selection, rows, file)).toThrow(
      "endpoints",
    );
});

it("resolves selections over existing textual hunks, including unchanged gaps", () => {
  const alignment = textualRows(
    "a",
    "@@ -2,2 +2,1 @@\n-deleted\n context",
    4,
    3,
  );
  expect(
    resolveDiffSelection(
      {
        file: "a",
        start: { side: "head", line: 1 },
        end: { side: "head", line: 3 },
      },
      alignment,
      { path: "a" },
    ),
  ).toEqual([
    { file: "a", side: "base", fromLine: 1, toLine: 4 },
    { file: "a", side: "head", fromLine: 1, toLine: 3 },
  ]);
});

it("rejects both retired authoring formats", () => {
  expect(
    diffSelectionSchema.safeParse({
      file: "a",
      side: "head",
      fromLine: 1,
      toLine: 2,
    }).success,
  ).toBe(false);
  expect(
    diffSelectionSchema.safeParse({
      file: "a",
      start: { baseLine: 1, headLine: 1 },
      end: { baseLine: 2, headLine: 2 },
    }).success,
  ).toBe(false);
});

it("orders mixed endpoints by alignment position rather than line number", () => {
  expect(
    resolveDiffSelection(
      {
        file: "a",
        start: { side: "base", line: 100 },
        end: { side: "head", line: 2 },
      },
      [
        [99, null],
        [null, 1],
      ],
      { path: "a" },
    ),
  ).toEqual([
    { file: "a", side: "base", fromLine: 100, toLine: 100 },
    { file: "a", side: "head", fromLine: 2, toLine: 2 },
  ]);
});
