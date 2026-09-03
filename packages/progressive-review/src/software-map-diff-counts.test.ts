import { describe, expect, it } from "vitest";

import {
  mapDiffLineCountsToCoverageClaims,
  mapDiffLineCountsToSoftwareMapElements,
  parseGitUnifiedDiffLineCounts,
} from "./software-map-diff-counts";

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,2 +10,3 @@
-oldA
-oldB
+newA
+newB
+newC
`;

describe("software map diff counts", () => {
  it("counts added and deleted hunk lines by current file and line", () => {
    const counts = parseGitUnifiedDiffLineCounts(patch);

    expect(
      Object.fromEntries(
        [...(counts.get("src/example.ts") ?? [])].map(([line, count]) => [
          line,
          { additions: count.additions, deletions: count.deletions },
        ]),
      ),
    ).toEqual({
      10: { additions: 1, deletions: 2 },
      11: { additions: 1, deletions: 0 },
      12: { additions: 1, deletions: 0 },
    });
  });

  it("maps changes through authored source ranges", () => {
    const countsByFile = parseGitUnifiedDiffLineCounts(patch);

    expect(
      mapDiffLineCountsToSoftwareMapElements({
        countsByFile,
        codeElements: [
          {
            path: "product.api.example",
            sourceRanges: [
              { file: "src/example.ts", fromLine: 10, toLine: 11 },
            ],
          },
          { path: "product.api.unmapped" },
        ],
      }),
    ).toEqual({
      countsByElementPath: {
        "product.api.example": { additions: 2, deletions: 2 },
      },
    });
  });

  it("keeps coverage hunk summaries for the map dropdown", () => {
    const countsByFile = parseGitUnifiedDiffLineCounts(patch);

    expect(
      mapDiffLineCountsToCoverageClaims({
        countsByFile,
        coverageClaims: [
          {
            path: "product.api",
            files: [{ path: "src/example.ts" }],
          },
        ],
      }),
    ).toMatchObject({
      "product.api": {
        additions: 3,
        deletions: 2,
        files: [{ file: "src/example.ts", additions: 3, deletions: 2 }],
      },
    });
  });
});

// A whole-file authored code element (e.g. the code-oss `editorOptions.ts`,
// 6895 lines) carrying a sparse 3-line diff. The diff-bounded implementation
// must attribute the three changes without walking every authored line.
const widePatch = `diff --git a/src/editorOptions.ts b/src/editorOptions.ts
index 1111111..2222222 100644
--- a/src/editorOptions.ts
+++ b/src/editorOptions.ts
@@ -1000,2 +1000,3 @@
 unchanged
 unchanged
+added1
@@ -3000,1 +3000,2 @@
 unchanged
+added2
@@ -5200,1 +5200,2 @@
 unchanged
+added3
`;

describe("mapDiffLineCountsToSoftwareMapElements across wide authored ranges", () => {
  it("counts only changed lines, never walking the whole authored range", () => {
    const countsByFile = parseGitUnifiedDiffLineCounts(widePatch);
    const fileCounts = countsByFile.get("src/editorOptions.ts");
    if (!fileCounts)
      throw new Error("expected changed-line counts for the file");

    const diffLines = fileCounts.size;
    const rangeSize = 6895;

    let getCalls = 0;
    // Duck-typed stand-in for the per-file counts map: count `.get` lookups
    // (the operation the range-walk regression performs once per authored
    // line) while delegating iteration to the real map for the diff-bounded
    // implementation's `for (const [line, counts] of fileCounts)` form.
    const countingFileCounts = {
      get: (key: number) => {
        getCalls += 1;
        return fileCounts.get(key);
      },
      [Symbol.iterator]: () => fileCounts[Symbol.iterator](),
    };
    const countingCountsByFile = new Map([
      ["src/editorOptions.ts", countingFileCounts],
    ]);

    mapDiffLineCountsToSoftwareMapElements({
      countsByFile: countingCountsByFile as never,
      codeElements: [
        {
          path: "product.editorOptions",
          sourceRanges: [
            {
              file: "src/editorOptions.ts",
              fromLine: 1,
              toLine: rangeSize,
            },
          ],
        },
      ],
    });

    // The buggy range-walk issued one `fileCounts.get` per authored line
    // (6895). The diff-bounded iteration must touch at most one entry per
    // changed diff line, never the authored range size.
    expect(diffLines).toBe(3);
    expect(getCalls).toBeLessThanOrEqual(diffLines);
    expect(getCalls).toBeLessThan(rangeSize);
  });
});
