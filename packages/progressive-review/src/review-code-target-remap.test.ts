import {
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  mapCodePositionSideThroughHunks,
  mapCodeSpanThroughHunks,
} from "./review-code-target-remap";
import { parseUnifiedPatch } from "./unified-diff";

describe("code target remapping", () => {
  it("moves an unchanged whole-line span through an insertion", () => {
    const hunks = parseUnifiedPatch(
      "src/example.ts",
      [
        "@@ -1,4 +1,6 @@",
        " first",
        "+inserted one",
        "+inserted two",
        " second",
        " third",
        " fourth",
      ].join("\n"),
    );

    expect(
      mapCodeSpanThroughHunks({ startLine: 3, endLine: 4 }, hunks),
    ).toEqual({ startLine: 5, endLine: 6 });
  });

  it("does not map a span when the diff removes one selected line", () => {
    const hunks = parseUnifiedPatch(
      "src/example.ts",
      ["@@ -2,3 +2,2 @@", " second", "-third", " fourth"].join("\n"),
    );

    expect(
      mapCodeSpanThroughHunks({ startLine: 3, endLine: 4 }, hunks),
    ).toBeNull();
  });

  it("remaps both coordinates of one cross-side position independently", () => {
    const position = createGitLabTextDiffPosition({
      base_sha: "old-base",
      start_sha: "old-base",
      head_sha: "old-head",
      old_path: "src/old.ts",
      new_path: "src/new.ts",
      start: { old_line: 3, new_line: null },
      end: { old_line: null, new_line: 5 },
    });
    const baseMapped = mapCodePositionSideThroughHunks({
      position,
      side: "base",
      newPath: "src/base-renamed.ts",
      hunks: parseUnifiedPatch(
        "src/base-renamed.ts",
        ["@@ -1,3 +1,4 @@", " one", "+inserted", " two", " three"].join("\n"),
      ),
      refs: {
        base_sha: "new-base",
        start_sha: "new-base",
        head_sha: "new-head",
      },
    });
    expect(baseMapped).not.toBeNull();
    const fullyMapped = mapCodePositionSideThroughHunks({
      position: baseMapped!,
      side: "head",
      newPath: "src/head-renamed.ts",
      hunks: parseUnifiedPatch(
        "src/head-renamed.ts",
        [
          "@@ -1,5 +1,6 @@",
          " one",
          "+inserted",
          " two",
          " three",
          " four",
          " five",
        ].join("\n"),
      ),
      refs: {
        base_sha: "new-base",
        start_sha: "new-base",
        head_sha: "new-head",
      },
    });

    expect(fullyMapped).toMatchObject({
      base_sha: "new-base",
      start_sha: "new-base",
      head_sha: "new-head",
      old_path: "src/base-renamed.ts",
      new_path: "src/head-renamed.ts",
    });
    expect(gitLabDiffPositionRows(fullyMapped!)).toEqual({
      start: { old_line: 4, new_line: null },
      end: { old_line: null, new_line: 6 },
    });
  });
});
