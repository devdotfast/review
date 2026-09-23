import { expect, it } from "vitest";

import {
  type CoverageFile,
  coverageProgress,
  mergeCoverageProgress,
  scopedCoverage,
  updateCoverage,
} from "./viewed-coverage";

const file: CoverageFile = {
  path: "new.ts",
  previousPath: "old.ts",
  fingerprint: "same",
  changed: { base: [[4, 7]], head: [[9, 20]] },
  viewed: { base: [], head: [] },
};

it("overlapping lenses count changed lines once and share completion", () => {
  const sources = [
    { side: "head" as const, file: "new.ts", fromLine: 10, toLine: 15 },
    { side: "head" as const, file: "new.ts", fromLine: 12, toLine: 18 },
  ];

  const scope = scopedCoverage(file, sources);
  expect(scope.head).toEqual([[9, 18]]);
  const updated = { ...file, viewed: updateCoverage(file.viewed, scope, true) };
  expect(coverageProgress([updated], sources)).toEqual({
    state: "viewed",
    total: { additions: 9, deletions: 0 },
    remaining: { additions: 0, deletions: 0 },
    folded: { additions: 0, deletions: 0 },
  });
  expect(coverageProgress([updated])).toEqual({
    state: "partial",
    total: { additions: 11, deletions: 3 },
    remaining: { additions: 2, deletions: 3 },
    folded: { additions: 0, deletions: 0 },
  });
});

it("unchecking one overlapping scope preserves coverage outside it, including the opposite side", () => {
  const viewed = {
    base: [[4, 7] as [number, number]],
    head: [[9, 20] as [number, number]],
  };

  const result = updateCoverage(viewed, { base: [], head: [[12, 16]] }, false);
  expect(result).toEqual({
    base: [[4, 7]],
    head: [
      [9, 12],
      [16, 20],
    ],
  });
  expect(
    scopedCoverage(file, [
      { side: "base", file: "old.ts", fromLine: 1, toLine: 100 },
    ]).base,
  ).toEqual([[4, 7]]);
});

it("unchanged context alone is neutral and does not inflate completion", () => {
  const sources = [
    { side: "head" as const, file: "new.ts", fromLine: 1, toLine: 8 },
  ];

  expect(coverageProgress([file], sources)).toEqual({
    state: "unread",
    total: { additions: 0, deletions: 0 },
    remaining: { additions: 0, deletions: 0 },
    folded: { additions: 0, deletions: 0 },
  });
});

it("folded lines count as done and leave only the unfolded ones remaining", () => {
  const folded: CoverageFile = {
    ...file,
    folded: { base: [[4, 7]], head: [[15, 20]] },
  };

  expect(coverageProgress([folded])).toEqual({
    state: "unread",
    total: { additions: 11, deletions: 3 },
    remaining: { additions: 6, deletions: 0 },
    folded: { additions: 5, deletions: 3 },
  });

  // Viewing every unfolded line finishes the file.
  const viewed: CoverageFile = {
    ...folded,
    viewed: { base: [], head: [[9, 15]] },
  };

  expect(coverageProgress([viewed])).toMatchObject({
    state: "viewed",
    remaining: { additions: 0, deletions: 0 },
  });

  // A viewed mark on a folded line is a viewed line, not a folded one.
  const opened: CoverageFile = {
    ...folded,
    viewed: { base: [[4, 7]], head: [] },
  };

  expect(coverageProgress([opened])).toMatchObject({
    state: "partial",
    remaining: { additions: 6, deletions: 0 },
    folded: { additions: 5, deletions: 0 },
  });
});

it("a scope with only folded lines left, and none marked, reads as folded", () => {
  const hidden: CoverageFile = { ...file, folded: file.changed };

  expect(coverageProgress([hidden])).toEqual({
    state: "folded",
    total: { additions: 11, deletions: 3 },
    remaining: { additions: 0, deletions: 0 },
    folded: { additions: 11, deletions: 3 },
  });

  // Lens scopes and merged comparisons follow the same rule.
  const sources = [
    { side: "head" as const, file: "new.ts", fromLine: 10, toLine: 12 },
  ];

  expect(coverageProgress([hidden], sources).state).toBe("folded");
  expect(
    mergeCoverageProgress([
      coverageProgress([hidden]),
      coverageProgress([{ ...file, viewed: file.changed }]),
    ]).state,
  ).toBe("viewed");
});

it("without structural folds every changed line is left to read", () => {
  expect(coverageProgress([file])).toMatchObject({
    state: "unread",
    remaining: { additions: 11, deletions: 3 },
    folded: { additions: 0, deletions: 0 },
  });
});
