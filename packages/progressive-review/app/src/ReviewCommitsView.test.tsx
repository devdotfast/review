import { describe, expect, it } from "vitest";

import { groupCommitsByDate, shapeCommitFiles } from "./ReviewCommitsView";

describe("shapeCommitFiles", () => {
  it("omits tests, sorts by total changes, and caps the result", () => {
    const files = [
      {
        path: "src/low.ts",
        status: "modified" as const,
        additions: 1,
        deletions: 0,
      },
      {
        path: "src/high.ts",
        status: "modified" as const,
        additions: 7,
        deletions: 3,
      },
      {
        path: "src/high.test.ts",
        status: "modified" as const,
        additions: 100,
        deletions: 0,
      },
      {
        path: "src/__tests__/fixture.ts",
        status: "modified" as const,
        additions: 50,
        deletions: 0,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "modified" as const,
        additions: index + 2,
        deletions: 0,
      })),
    ];

    const result = shapeCommitFiles(files);

    expect(result.testFilesOmitted).toBe(2);
    expect(result.overflowFilesOmitted).toBe(2);
    expect(result.files).toHaveLength(8);
    expect(result.files[0]?.path).toBe("src/high.ts");
    expect(result.files.some((file) => file.path.includes("test"))).toBe(false);
  });
});

describe("groupCommitsByDate", () => {
  it("sorts by author time and creates one group for each date", () => {
    const commit = {
      commit: "a".repeat(40),
      parentCommit: "b".repeat(40),
      subject: "Change",
      author: "Developer",
      authoredAt: "2026-08-11T18:00:00-04:00",
      fileCount: 1,
      additions: 1,
      deletions: 0,
    };
    const groups = groupCommitsByDate([
      commit,
      {
        ...commit,
        commit: "c".repeat(40),
        authoredAt: "2026-08-12T12:00:00-04:00",
      },
      {
        ...commit,
        commit: "d".repeat(40),
        authoredAt: "2026-08-11T20:00:00-04:00",
      },
    ]);

    expect(
      groups.map((group) => group.commits.map((entry) => entry.commit)),
    ).toEqual([["c".repeat(40)], ["d".repeat(40), "a".repeat(40)]]);
  });
});
