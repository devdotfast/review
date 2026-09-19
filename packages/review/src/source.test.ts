import { describe, expect, it } from "vitest";

import {
  SourceRangeError,
  checkSourcePath,
  requireVisibleSource,
  sliceSourceRange,
  sourceSchema,
} from "./source";
import {
  codeEvidenceSchema,
  evidenceSources,
  upgradeStoredEvidence,
} from "./source.js";

describe("sourceSchema", () => {
  it("accepts a pinned range and rejects one that ends before it starts", () => {
    expect(
      sourceSchema.parse({
        side: "head",
        file: "src/a.ts",
        fromLine: 3,
        toLine: 3,
      }),
    ).toEqual({ side: "head", file: "src/a.ts", fromLine: 3, toLine: 3 });
    expect(() =>
      sourceSchema.parse({
        side: "base",
        file: "src/a.ts",
        fromLine: 4,
        toLine: 3,
      }),
    ).toThrow("ends before it starts");
  });
});

describe("checkSourcePath", () => {
  it("accepts repository-relative paths", () => {
    expect(() => checkSourcePath("src/a.ts")).not.toThrow();
    expect(() => checkSourcePath("")).not.toThrow();
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "src/./a.ts",
    "src\\a.ts",
    "src/\u0001.ts",
  ])("rejects %j", (file) => {
    expect(() => checkSourcePath(file)).toThrow(SourceRangeError);
    expect(() => checkSourcePath(file)).toThrow("repository-relative");
  });
});

describe("sliceSourceRange", () => {
  const text = "one\ntwo\nthree\n";

  it("returns the inclusive range and ignores the trailing newline", () => {
    expect(sliceSourceRange(text, { file: "f", fromLine: 2, toLine: 3 })).toBe(
      "two\nthree",
    );
    expect(() =>
      sliceSourceRange(text, { file: "f", fromLine: 1, toLine: 4 }),
    ).toThrow("f:1-4 exceeds the pinned file (3 lines)");
  });

  it("rejects an empty file", () => {
    expect(() =>
      sliceSourceRange("", { file: "f", fromLine: 1, toLine: 1 }),
    ).toThrow("exceeds the pinned file");
  });

  it("accepts CRLF text", () => {
    expect(
      sliceSourceRange("a\r\nb\r\n", { file: "f", fromLine: 2, toLine: 2 }),
    ).toBe("b");
  });
});

describe("requireVisibleSource", () => {
  it("rejects whitespace-only peeks and accepts anything else", () => {
    const range = { file: "f", fromLine: 5, toLine: 6 };

    expect(() => requireVisibleSource(" \n\t", range)).toThrow(
      "f:5-6 contains only whitespace",
    );
    expect(() => requireVisibleSource("x", range)).not.toThrow();
  });
});

it("reads old saved diffr evidence without losing selected sides or fold state", () => {
  const legacy = {
    kind: "rhs",
    scope: {
      repo: "/gone",
      baseWorktree: { commitId: "base", path: "/gone/base" },
      headWorktree: { commitId: "head", path: "/gone/head" },
    },
    file: { rhs: { path: "a.ts", oid: "a".repeat(40), mode: "100644" } },
    sources: {
      rhs: {
        text: "match\nhidden\n",
        regions: [
          {
            kind: "leaf",
            id: 1,
            fold_state_id: 1,
            alignment_id: 1,
            start: { line: 0, column: 0 },
            end: { line: 1, column: 0 },
            search_highlights: [{ line: 0, start_column: 0, end_column: 5 }],
          },
          {
            kind: "leaf",
            id: 2,
            fold_state_id: 2,
            alignment_id: 2,
            start: { line: 1, column: 0 },
            end: { line: 2, column: 0 },
            visibility: { collapsed: true },
          },
        ],
      },
    },
  };
  const evidence = codeEvidenceSchema.parse(upgradeStoredEvidence(legacy));
  expect(evidenceSources(evidence)).toEqual([
    { side: "head", file: "a.ts", fromLine: 1, toLine: 1 },
  ]);
  if (!("display" in evidence)) throw new Error("Expected search evidence");
  expect(evidence.display).toBe("rhs");
  expect(evidence.sources.rhs?.regions[1].visibility?.collapsed).toBe(true);
  expect(evidence.sources.rhs?.text).toBe("match\nhidden\n");
  expect(evidence.sources.lhs).toBeUndefined();
  expect(legacy.kind).toBe("rhs");
});
