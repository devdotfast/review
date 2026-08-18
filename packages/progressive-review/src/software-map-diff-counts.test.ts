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

  it("maps changes through authored source ranges", async () => {
    const countsByFile = parseGitUnifiedDiffLineCounts(patch);

    await expect(
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
    ).resolves.toEqual({
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
