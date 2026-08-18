import { describe, expect, it } from "vitest";

import {
  codePeekRootSourceRanges,
  sliceReviewDiffFileToCodePeekRanges,
} from "./codepeek-symbol-diff";
import type { ReviewDiffFile } from "./review-diff-files";
import type { SourceSnapshot } from "./source-code-types";

describe("codePeekRootSourceRanges", () => {
  it("uses root source ranges", () => {
    const snapshot = sourceSnapshot({
      roots: ["source-range:src/example.ts:1-5"],
      sources: {
        "source-range:src/example.ts:1-5": {
          file: "src/example.ts",
          line: 1,
          endLine: 5,
        },
        "source-range:src/example.ts:20-30": {
          file: "src/example.ts",
          line: 20,
          endLine: 30,
        },
      },
    });

    expect(codePeekRootSourceRanges(snapshot)).toEqual([
      { file: "src/example.ts", fromLine: 1, toLine: 5 },
    ]);
  });
});

describe("sliceReviewDiffFileToCodePeekRanges", () => {
  it("keeps only hunks that touch the head declaration range", () => {
    const sliced = sliceReviewDiffFileToCodePeekRanges({
      file: reviewDiffFile(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,9 +1,9 @@
 export function target() {
-  return 1;
+  return 2;
 }
 
 export function other() {
-  return 3;
+  return 4;
 }`),
      ranges: [{ file: "src/example.ts", fromLine: 1, toLine: 3 }],
      orientation: "head",
      contextLines: 0,
    });

    expect(sliced).not.toBeNull();
    expect(sliced?.additions).toBe(1);
    expect(sliced?.deletions).toBe(1);
    expect(sliced?.patch).toContain("+  return 2;");
    expect(sliced?.patch).not.toContain("return 4");
  });

  it("keeps the declaration opening when full diff context is available", () => {
    const sliced = sliceReviewDiffFileToCodePeekRanges({
      file: reviewDiffFile(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,8 +1,8 @@
 export function target() {
   const one = 1;
   const two = 2;
-  const three = 3;
+  const three = 30;
   const four = 4;
   return one + two + three + four;
 }
 
 export function other() {}`),
      ranges: [{ file: "src/example.ts", fromLine: 1, toLine: 7 }],
      orientation: "head",
      contextLines: 0,
    });

    const patchLines = sliced?.patch?.split(/\n/) ?? [];
    expect(patchLines).toContain(" export function target() {");
    expect(patchLines.indexOf(" export function target() {")).toBeLessThan(
      patchLines.indexOf("-  const three = 3;"),
    );
    expect(sliced?.patch).not.toContain("export function other");
  });

  it("anchors removed lines to the base declaration range for base peeks", () => {
    const sliced = sliceReviewDiffFileToCodePeekRanges({
      file: reviewDiffFile(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -8,5 +8,4 @@ export function target() {
   const kept = true;
-  const removed = true;
   return kept;
 }`),
      ranges: [{ file: "src/example.ts", fromLine: 9, toLine: 9 }],
      orientation: "base",
      contextLines: 0,
    });

    expect(sliced).not.toBeNull();
    expect(sliced?.additions).toBe(0);
    expect(sliced?.deletions).toBe(1);
    expect(sliced?.patch).toContain("-  const removed = true;");
  });

  it("returns null when the diff does not touch the declaration range", () => {
    const sliced = sliceReviewDiffFileToCodePeekRanges({
      file: reviewDiffFile(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -20,3 +20,3 @@ export function other() {
-  return 3;
+  return 4;
 }`),
      ranges: [{ file: "src/example.ts", fromLine: 1, toLine: 3 }],
      orientation: "head",
    });

    expect(sliced).toBeNull();
  });
});

function reviewDiffFile(patch: string): ReviewDiffFile {
  return {
    path: "src/example.ts",
    status: "modified",
    additions: (patch.match(/^\+/gm) ?? []).length - 1,
    deletions: (patch.match(/^-/gm) ?? []).length - 1,
    patch,
  };
}

function sourceSnapshot(input: {
  roots: string[];
  sources: Record<string, { file: string; line: number; endLine: number }>;
}): SourceSnapshot {
  return {
    roots: input.roots.map((sourceId) => ({
      kind: "source",
      sourceId,
    })),
    resolved: Object.fromEntries(
      Object.entries(input.sources).map(([id, source]) => [
        id,
        {
          source: {
            id,
            name: id,
            kind: "source-range",
            file: source.file,
            line: source.line,
            endLine: source.endLine,
          },
          lines: [],
        },
      ]),
    ),
  };
}
