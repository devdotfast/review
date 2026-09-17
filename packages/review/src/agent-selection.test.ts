import { expect, it } from "vitest";

import { AgentSelectionSchema, selectedDiffMarkdown } from "./agent-selection";

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
    "Base: a/\nHead: b/\nRange: -20,3 +10,4\n\n```diff\n before\n-old\n+new\n+extra\n after",
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
  ).toContain("Range: -9,1 +12,1\n\n```diff\n hello");
  expect(
    selectedDiffMarkdown({
      oldPath: "f",
      newPath: "f",
      oldStart: 9,
      newStart: 10,
      rows: [{ kind: "added", text: "hello" }],
    }),
  ).toContain("Range: -9,0 +10,1\n\n```diff\n+hello");
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

it("uses pinned worktree roots even when the file is absent on one side", () => {
  const diff = {
    oldPath: "f.ts",
    newPath: "f.ts",
    oldStart: 1,
    newStart: 1,
    rows: [{ kind: "unchanged" as const, text: "hello" }],
  };

  const paths = { base: "/pinned/base", head: "/pinned/head" };
  expect(selectedDiffMarkdown(diff, paths)).toContain(
    "Base: /pinned/base\nHead: /pinned/head",
  );
  expect(selectedDiffMarkdown({ ...diff, oldPath: "" }, paths)).toContain(
    "Base: /pinned/base\nHead: /pinned/head",
  );
});

it("rejects graph selections and diagram context at the copy boundary", () => {
  expect(
    AgentSelectionSchema.safeParse({
      title: "Diagram",
      target: {
        kind: "graph",
        diagram: "DB",
        label: "Orders",
        elementType: "node",
      },
    }).success,
  ).toBe(false);
  expect(
    AgentSelectionSchema.safeParse({
      title: "Prose",
      target: { kind: "text", quote: "hello" },
      diagramContext: { kind: "node" },
    }).success,
  ).toBe(false);
});
