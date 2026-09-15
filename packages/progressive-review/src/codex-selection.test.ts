import { expect, it } from "vitest";

import { selectedDiffMarkdown, selectionMarkdown } from "./codex-selection";

it("preserves mixed diff rows and independent line counts", () => {
  const text = selectedDiffMarkdown({
    oldPath: "old.ts",
    newPath: "new.ts",
    oldStart: 20,
    newStart: 10,
    rows: [
      { kind: "unchanged", text: "before" },
      { kind: "deleted", text: "old" },
      { kind: "added", text: "new" },
      { kind: "added", text: "extra" },
      { kind: "unchanged", text: "after" },
    ],
  });

  expect(text).toContain(
    "--- a/old.ts\n+++ b/new.ts\n@@ -20,3 +10,4 @@\n before\n-old\n+new\n+extra\n after",
  );
});

it("retains unchanged-only selections and zero-count insertion coordinates", () => {
  expect(
    selectedDiffMarkdown({
      oldPath: "f",
      newPath: "f",
      oldStart: 9,
      newStart: 12,
      rows: [{ kind: "unchanged", text: "hello" }],
    }),
  ).toContain("@@ -9,1 +12,1 @@\n hello");
  expect(
    selectedDiffMarkdown({
      oldPath: "f",
      newPath: "f",
      oldStart: 9,
      newStart: 10,
      rows: [{ kind: "added", text: "hello" }],
    }),
  ).toContain("@@ -9,0 +10,1 @@\n+hello");
});

it("escapes a selection containing Markdown code fences", () => {
  const text = selectedDiffMarkdown({
    oldPath: "f.md",
    newPath: "f.md",
    oldStart: 1,
    newStart: 1,
    rows: [{ kind: "unchanged", text: "```sh" }],
  });

  expect(text).toContain("````diff\n");
  expect(text.endsWith("\n````")).toBe(true);
});

it("uses pinned absolute header paths and /dev/null for a missing side", () => {
  const diff = {
    oldPath: "f.ts",
    newPath: "f.ts",
    oldStart: 1,
    newStart: 1,
    rows: [{ kind: "unchanged" as const, text: "hello" }],
  };

  const paths = { base: "/pinned/base/f.ts", head: "/pinned/head/f.ts" };
  expect(selectedDiffMarkdown(diff, paths)).toContain(
    "--- /pinned/base/f.ts\n+++ /pinned/head/f.ts",
  );
  expect(selectedDiffMarkdown({ ...diff, oldPath: "" }, paths)).toContain(
    "--- /dev/null\n+++ /pinned/head/f.ts",
  );
});

it("omits selection text for whole-file context", () => {
  expect(
    selectionMarkdown({
      target: { kind: "document" },
      title: "file.ts",
      fileOnly: true,
    }),
  ).toBe("");
});
