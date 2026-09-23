import { describe, expect, it } from "vitest";

import { whiteboardCodePeekRangeCounts } from "./code-peek-diff.js";

const replacement = "@@ -1,3 +1,3 @@\n A\n-B\n+C\n D";

const range = (
  startLine: number,
  endLine = startLine,
  side?: "head" | "base",
) => ({ startLine, endLine, side });

describe("authored peek counts", () => {
  it("excludes context and keeps opposite-side replacement anchors", () => {
    expect(
      whiteboardCodePeekRangeCounts(replacement, [range(2)], "head"),
    ).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(
      whiteboardCodePeekRangeCounts(replacement, [range(1)], "head"),
    ).toBeUndefined();
    expect(
      whiteboardCodePeekRangeCounts(replacement, [range(2)], "base"),
    ).toEqual({
      additions: 0,
      deletions: 1,
    });
    expect(
      whiteboardCodePeekRangeCounts(replacement, [range(3)], "base"),
    ).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("counts overlapping original entries independently with each explicit side", () => {
    expect(
      whiteboardCodePeekRangeCounts(
        replacement,
        [range(2), range(3, 1)],
        "head",
      ),
    ).toEqual({ additions: 2, deletions: 2 });
    expect(
      whiteboardCodePeekRangeCounts(
        replacement,
        [range(2), range(2, 2, "base")],
        "head",
      ),
    ).toEqual({ additions: 1, deletions: 2 });
    expect(
      whiteboardCodePeekRangeCounts(
        replacement,
        [range(1), range(2), range(3)],
        "head",
      ),
    ).toEqual({ additions: 1, deletions: 1 });
  });

  it("anchors deletion to the next head line or past the last head line at EOF", () => {
    expect(
      whiteboardCodePeekRangeCounts(
        "@@ -1,3 +1,2 @@\n A\n-B\n D",
        [range(2)],
        "head",
      ),
    ).toEqual({ additions: 0, deletions: 1 });
    const eof = "@@ -1,2 +1 @@\n A\n-B\n\\ No newline at end of file";
    expect(whiteboardCodePeekRangeCounts(eof, [range(2)], "head")).toEqual({
      additions: 0,
      deletions: 1,
    });
    expect(
      whiteboardCodePeekRangeCounts(eof, [range(1)], "head"),
    ).toBeUndefined();
  });

  it("anchors a whole-file addition or deletion to line one on the empty side", () => {
    expect(
      whiteboardCodePeekRangeCounts(
        "@@ -0,0 +1,2 @@\n+A\n+B",
        [range(1)],
        "base",
      ),
    ).toEqual({ additions: 2, deletions: 0 });
    expect(
      whiteboardCodePeekRangeCounts(
        "@@ -1,2 +0,0 @@\n-A\n-B",
        [range(1)],
        "head",
      ),
    ).toEqual({ additions: 0, deletions: 2 });
  });

  it("keeps independent hunk anchors and ignores missing or non-text patches", () => {
    expect(
      whiteboardCodePeekRangeCounts(
        "@@ -4,0 +5 @@\n+E\n@@ -10 +11 @@\n K",
        [range(5)],
        "base",
      ),
    ).toEqual({ additions: 1, deletions: 0 });

    for (const patch of [
      undefined,
      "",
      "Binary files a and b differ",
      "similarity index 100%\nrename from a\nrename to b",
    ]) {
      expect(
        whiteboardCodePeekRangeCounts(patch, [range(1, 100)], "head"),
      ).toBeUndefined();
    }
  });
});
