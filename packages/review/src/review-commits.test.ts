import { describe, expect, it } from "vitest";

import { resolveReviewCommitScope } from "./review-commits";

const commit = {
  commit: "b".repeat(40),
  parentCommit: "a".repeat(40),
  subject: "Change",
  author: "Developer",
  authoredAt: "2026-08-12T12:00:00Z",
  fileCount: 1,
  additions: 2,
  deletions: 1,
};

describe("resolveReviewCommitScope", () => {
  it("derives the first-parent range for a pinned commit", () => {
    expect(resolveReviewCommitScope([commit], commit.commit)).toEqual({
      baseRef: commit.parentCommit,
      headRef: commit.commit,
    });
  });

  it("rejects commits outside the pinned range", () => {
    expect(() => resolveReviewCommitScope([commit], "c".repeat(40))).toThrow(
      "outside the pinned review range",
    );
  });
});
