import { describe, expect, it } from "vitest";

import {
  SourceRangeError,
  checkSourcePath,
  requireVisibleSource,
  sliceSourceRange,
  fileLineRangeSchema,
} from "./source";

describe("fileLineRangeSchema", () => {
  it("accepts a pinned range and rejects one that ends before it starts", () => {
    expect(
      fileLineRangeSchema.parse({
        side: "head",
        file: "src/a.ts",
        fromLine: 3,
        toLine: 3,
      }),
    ).toEqual({ side: "head", file: "src/a.ts", fromLine: 3, toLine: 3 });
    expect(() =>
      fileLineRangeSchema.parse({
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
