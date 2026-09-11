import { randomUUID } from "node:crypto";

import {
  type HostBinding,
  type HostMapAnalysisInput,
  type HostMapVersion,
  type HostSourceSpan,
} from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import { analyzeMapChanges } from "./map-analysis";

const repositoryId = randomUUID();
const binding: HostBinding = {
  id: randomUUID(),
  repositoryId,
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  selector: { kind: "range", baseRef: "main", headRef: "feature" },
  createdAt: "2026-09-10T10:00:00Z",
};
const request: HostMapAnalysisInput = {
  reviewId: randomUUID(),
  reviewVersion: 3,
};
function span(
  fromLine: number,
  toLine = fromLine,
  file = "file.ts",
): HostSourceSpan {
  return {
    repositoryId,
    commit: binding.headCommit,
    blob: "c".repeat(40),
    file,
    fromLine,
    toLine,
  };
}
function map(
  side: "base" | "head",
  elements: Record<
    string,
    { source?: HostSourceSpan[]; parentId?: string; label?: string }
  >,
): HostMapVersion {
  return {
    id: randomUUID(),
    mapId: randomUUID(),
    mapVersion: 0,
    schemaVersion: 1,
    repositoryId,
    commit: side === "base" ? binding.baseCommit : binding.headCommit,
    contentHash: "d".repeat(64),
    createdAt: binding.createdAt,
    relationships: {},
    elements: Object.fromEntries(
      Object.entries(elements).map(([id, value]) => [
        id,
        {
          id,
          parentId: value.parentId ?? null,
          kind: "component",
          label: value.label ?? id,
          description: "",
          source: (value.source ?? []).map((source) => ({
            ...source,
            commit: side === "base" ? binding.baseCommit : binding.headCommit,
          })),
        },
      ]),
    ),
  };
}
const edit =
  "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n-old();\n-oldOther();\n+new();\n+newOther();\n";

describe("saved map source attribution", () => {
  it("counts the union of own and descendant ranges once, regardless of output filters and paging", () => {
    const base = map("base", {
      parent: { source: [span(2, 3)] },
      child: { parentId: "parent", source: [span(2)] },
    });
    const head = map("head", {
      parent: { source: [span(2, 3)] },
      child: { parentId: "parent", source: [span(2)] },
    });
    const all = analyzeMapChanges({
      request,
      binding,
      maps: { base, head },
      patch: edit,
    });
    expect(
      all.items.map((item) => [item.elementId, item.additions, item.deletions]),
    ).toEqual([
      ["child", 1, 1],
      ["parent", 2, 2],
    ]);
    expect(all.items.every((item) => item.diff === undefined)).toBe(true);
    const filtered = analyzeMapChanges({
      request: { ...request, elementIds: ["parent"] },
      binding,
      maps: { base, head },
      patch: edit,
    });
    expect(filtered.items).toEqual([all.items[1]]);
    const first = analyzeMapChanges({
      request: { ...request, limit: 1 },
      binding,
      maps: { base, head },
      patch: edit,
    });
    const second = analyzeMapChanges({
      request: { ...request, limit: 1, cursor: first.nextCursor! },
      binding,
      maps: { base, head },
      patch: edit,
    });
    expect(second.items).toEqual([all.items[1]]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      analyzeMapChanges({
        request: { ...request, includeDiff: true, cursor: first.nextCursor! },
        binding,
        maps: { base, head },
        patch: edit,
      }),
    ).toThrow(/Refresh/);
  });

  it("distinguishes presence in a saved pair but never treats a single-side view as added or removed", () => {
    const base = map("base", { removed: {}, same: { label: "Before" } });
    const head = map("head", { added: {}, same: { label: "After" } });
    const pair = analyzeMapChanges({
      request,
      binding,
      maps: { base, head },
      patch: "",
    });
    expect(
      pair.items.map((item) => [item.elementId, item.changeStatus]),
    ).toEqual([
      ["added", "added"],
      ["removed", "removed"],
      ["same", "unchanged"],
    ]);
    const single = analyzeMapChanges({
      request,
      binding,
      maps: { base: null, head },
      patch: "",
    });
    expect(
      single.items.every((item) => item.changeStatus === "unchanged"),
    ).toBe(true);
    expect(
      analyzeMapChanges({
        request,
        binding,
        maps: { base: null, head: null },
        patch: "",
      }).items,
    ).toEqual([]);
  });

  it("retains explicit coordinates and counterpart rows when a single selected map overlaps an edit", () => {
    const head = map("head", { app: { source: [span(2, 3)] } });
    const [item] = analyzeMapChanges({
      request: { ...request, includeDiff: true },
      binding,
      maps: { base: null, head },
      patch: edit,
    }).items;
    expect(item).toMatchObject({
      additions: 2,
      deletions: 2,
      changeStatus: "modified",
    });
    expect(item!.diff!.files[0]!.hunks[0]).toEqual({
      baseRange: { startLine: 2, lineCount: 2 },
      headRange: { startLine: 2, lineCount: 2 },
      attribution: "overlap",
      lines: [
        { kind: "remove", baseLine: 2, headLine: null, text: "old();" },
        { kind: "remove", baseLine: 3, headLine: null, text: "oldOther();" },
        { kind: "add", baseLine: null, headLine: 2, text: "new();" },
        { kind: "add", baseLine: null, headLine: 3, text: "newOther();" },
      ],
    });
  });

  it("marks zero-width single-side boundaries without fabricating source line zero", () => {
    const base = map("base", { app: { source: [span(1)] } });
    const patch =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+inserted();\n";
    const [item] = analyzeMapChanges({
      request: { ...request, includeDiff: true },
      binding,
      maps: { base, head: null },
      patch,
    }).items;
    expect(item).toMatchObject({
      additions: 1,
      deletions: 0,
      changeStatus: "modified",
    });
    expect(item!.diff!.files[0]!.hunks[0]).toMatchObject({
      baseRange: { startLine: 0, lineCount: 0 },
      attribution: "boundary",
      lines: [
        { kind: "add", baseLine: null, headLine: 1, text: "inserted();" },
      ],
    });
  });

  it("preserves old/new paths on renames including spaces, quotes and UTF-8", () => {
    const basePath = 'old café "file".ts',
      headPath = 'new café "file".ts';
    const base = map("base", { app: { source: [span(1, 1, basePath)] } });
    const head = map("head", { app: { source: [span(1, 1, headPath)] } });
    const patch = `diff --git old new\n--- ${JSON.stringify(`a/${basePath}`)}\n+++ ${JSON.stringify(`b/${headPath}`)}\n@@ -1 +1 @@\n-old\n+new\n`;
    const [item] = analyzeMapChanges({
      request: { ...request, includeDiff: true },
      binding,
      maps: { base, head },
      patch,
    }).items;
    expect(item!.diff!.files[0]).toMatchObject({
      baseFile: basePath,
      headFile: headPath,
    });
    expect(item).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("rejects absent selections, foreign cursors and excessive attribution work", () => {
    const head = map("head", { app: { source: [span(9000)] } });
    expect(() =>
      analyzeMapChanges({
        request: { ...request, elementIds: ["missing"] },
        binding,
        maps: { base: null, head },
        patch: edit,
      }),
    ).toThrow(/absent/);
    expect(() =>
      analyzeMapChanges({
        request: { ...request, cursor: "garbage" },
        binding,
        maps: { base: null, head },
        patch: edit,
      }),
    ).toThrow(/Refresh/);
    const wide = map("head", {
      app: {
        source: Array.from({ length: 501 }, (_, index) => span(9000 + index)),
      },
    });
    const patch = `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,0 +1,4000 @@\n${Array.from({ length: 4000 }, () => "+line").join("\n")}\n`;
    expect(() =>
      analyzeMapChanges({
        request,
        binding,
        maps: { base: null, head: wide },
        patch,
      }),
    ).toThrow(/2,000,000/);
  });
});
