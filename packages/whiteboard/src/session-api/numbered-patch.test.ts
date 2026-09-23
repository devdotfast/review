import { describe, expect, it } from "vitest";

import { budgetPatches, numberPatch } from "./numbered-patch.js";

const lines = (...rows: string[]) => rows.join("\n") + "\n";

describe("numberPatch", () => {
  it("numbers a modified file across hunks with base and head lines", () => {
    expect(
      numberPatch(
        lines(
          "diff --git a/x.ts b/x.ts",
          "index 1111111..2222222 100644",
          "--- a/x.ts",
          "+++ b/x.ts",
          "@@ -8,3 +8,4 @@ class X {",
          " a",
          "-b",
          "+c",
          "+d",
          " e",
          "@@ -95,2 +96,2 @@",
          " f",
          "--- g",
          "+h",
        ),
      ),
    ).toBe(
      lines(
        "diff --git a/x.ts b/x.ts",
        "@@ -8,3 +8,4 @@ class X {",
        " 8  8  a",
        " 9    -b",
        "    9 +c",
        "   10 +d",
        "10 11  e",
        "@@ -95,2 +96,2 @@",
        "95 96  f",
        "96    --- g",
        "   97 +h",
      ),
    );
  });

  it("numbers an added file on the head side only", () => {
    expect(
      numberPatch(
        lines(
          "diff --git a/new.ts b/new.ts",
          "new file mode 100644",
          "index 0000000..1111111",
          "--- /dev/null",
          "+++ b/new.ts",
          "@@ -0,0 +1,2 @@",
          "+one",
          "+two",
        ),
      ),
    ).toBe(
      lines(
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "@@ -0,0 +1,2 @@",
        "  1 +one",
        "  2 +two",
      ),
    );
  });

  it("numbers a deleted file on the base side only", () => {
    expect(
      numberPatch(
        lines(
          "diff --git a/old.ts b/old.ts",
          "deleted file mode 100644",
          "--- a/old.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-gone",
        ),
      ),
    ).toBe(
      lines(
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "@@ -1 +0,0 @@",
        "1   -gone",
      ),
    );
  });

  it("keeps both paths of a rename and marks a missing final newline", () => {
    expect(
      numberPatch(
        lines(
          "diff --git a/a.ts b/b.ts",
          "similarity index 80%",
          "rename from a.ts",
          "rename to b.ts",
          "--- a/a.ts",
          "+++ b/b.ts",
          "@@ -1,2 +1,2 @@",
          " same",
          "-old",
          "\\ No newline at end of file",
          "+new",
          "\\ No newline at end of file",
        ),
      ),
    ).toBe(
      lines(
        "diff --git a/a.ts b/b.ts",
        "similarity index 80%",
        "rename from a.ts",
        "rename to b.ts",
        "@@ -1,2 +1,2 @@",
        "1 1  same",
        "2   -old",
        "    \\ No newline at end of file",
        "  2 +new",
        "    \\ No newline at end of file",
      ),
    );
  });

  it("passes a binary file through", () => {
    expect(
      numberPatch(
        lines(
          "diff --git a/img.png b/img.png",
          "index 1111111..2222222 100644",
          "Binary files a/img.png and b/img.png differ",
        ),
      ),
    ).toBe(
      lines(
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
      ),
    );
  });
});

describe("budgetPatches", () => {
  const file = (path: string, added: number) => ({
    path,
    additions: added,
    deletions: 0,
    patch: lines(
      `diff --git a/${path} b/${path}`,
      `@@ -0,0 +1,${added} @@`,
      ...Array.from({ length: added }, (_, index) => `+line ${index}`),
    ),
  });

  it("returns whole files and lists the rest with a paths hint", () => {
    const text = budgetPatches(
      [file("a.ts", 2), file("b.ts", 40), file("c.md", 1)],
      120,
    );

    expect(text).toContain("diff --git a/a.ts b/a.ts");
    expect(text).not.toContain("diff --git a/b.ts");
    expect(text).not.toContain("diff --git a/c.md");
    expect(text).toMatch(
      /\[2 more files over the 120-byte budget: b\.ts \(\+40\), c\.md \(\+1\)\. Fetch them with paths:\["b\.ts","c\.md"\], format:"patch"\.\]\n$/,
    );
  });

  it("cuts a first file larger than the budget at a line with a marker", () => {
    const text = budgetPatches([file("big.ts", 100), file("next.ts", 1)], 200);

    expect(Buffer.byteLength(text.split("\n[")[0]!)).toBeLessThanOrEqual(200);
    expect(text).toContain("  1 +line 0");
    expect(text).toMatch(
      /\[big\.ts is cut at the 200-byte budget after \d+ of 102 lines\./,
    );
    expect(text).toContain('paths:["next.ts"]');
  });

  it("returns every file when they fit", () => {
    const text = budgetPatches([file("a.ts", 1), file("b.ts", 1)], 60_000);

    expect(text).toContain("diff --git a/b.ts b/b.ts");
    expect(text).not.toContain("budget");
  });
});
