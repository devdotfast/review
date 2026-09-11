/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { projectSourceAlignment } from "../../editor/common/diff/sourceLineAlignment.js";
import {
  assertFoldRangesNest,
  nativeFoldRange,
  structuralCountsTooltip,
  structuralFoldRanges,
  structuralFoldingRegions,
  structuralInitialCounts,
  structuralLabelPlan,
  structuralVisibleCounts,
  structuralHighlights,
  structuralRows,
  utf16Column,
  type StructuralRegion,
  type StructuralTextDiff,
} from "./reviewStructuralDiff.js";

function leaf(id: number, start: number, end: number, extra: Partial<Extract<StructuralRegion, { kind: "leaf" }>> = {}): StructuralRegion {
  return { id, kind: "leaf", start: { line: start, column: 0 }, end: { line: end, column: 0 }, ...extra };
}
function fold(id: number, children: StructuralRegion[], tags: string[] = ["body"]): StructuralRegion {
  const first = children[0], last = children[children.length - 1];
  return { id, kind: "fold", start: first.start, end: last.end, tags, children };
}
function text(lines: string[], regions: StructuralRegion[]) {
  return { text: lines.join("\n") + "\n", regions };
}
const stats = { textual: { added: 0, removed: 0 }, visible: { added: 0, removed: 0 } };

test("paired collapse removes hidden height without leaving padding for hidden anchors", () => {
  const rows: [number | null, number | null][] = [
    [0, 0],
    [1, 1],
    [null, 2],
    [2, 3],
    [3, 4],
  ];
  const segments = projectSourceAlignment(
    rows,
    (l) => (l === 1 || l === 2 ? 0 : 20),
    (r) => (r >= 1 && r <= 3 ? 0 : 20),
  );
  assert.deepEqual(
    segments.map((s) => [s.leftEnd, s.rightEnd, s.rightHeight - s.leftHeight]),
    [
      [3, 4, 0],
      [4, 5, 0],
    ],
  );
});

test("leaves zip by id into rows: paired line for line, unpaired one-sided, trailing empty lines paired", () => {
  const diff: StructuralTextDiff = {
    type: "text",
    stats,
    lhs: text(["a", "b", "c", "d"], [leaf(1, 0, 1), leaf(2, 1, 2), leaf(3, 2, 4)]),
    rhs: text(["a", "x", "b", "c", "d"], [leaf(1, 0, 1), leaf(9, 1, 2), leaf(2, 2, 3), leaf(3, 3, 5)]),
  };
  assert.deepEqual(structuralRows(diff), [
    [0, 0],
    [null, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ]);
});

test("a partner behind the cursor is a move and renders one-sided on both sides", () => {
  const diff: StructuralTextDiff = {
    type: "text",
    stats,
    lhs: text(["a", "b"], [leaf(1, 0, 1), leaf(2, 1, 2)]),
    rhs: text(["b", "a"], [leaf(2, 0, 1), leaf(1, 1, 2)]),
  };
  assert.deepEqual(structuralRows(diff), [
    [null, 0],
    [0, 1],
    [1, null],
    [2, 2],
  ]);
});

test("one-sided files and nested folds still tile", () => {
  const added: StructuralTextDiff = {
    type: "text",
    stats,
    rhs: text(["fn f() {", "  1", "}"], [fold(1, [leaf(2, 0, 1), leaf(3, 1, 2), leaf(4, 2, 3)])]),
  };
  assert.deepEqual(structuralRows(added), [
    [null, 0],
    [null, 1],
    [null, 2],
    [null, 3],
  ]);
  assert.throws(
    () => structuralRows({ type: "text", stats, lhs: text(["a", "b"], [leaf(1, 0, 2)]), rhs: text(["a"], [leaf(1, 0, 1)]) }),
    /differ in length/,
  );
  assert.throws(
    () => structuralRows({ type: "text", stats, lhs: text(["a", "b"], [leaf(1, 1, 2), leaf(2, 0, 1)]) }),
    /tile the file/,
  );
});

test("fold endpoints are exclusive and inline ranges cannot become native line folds", () => {
  assert.deepEqual(nativeFoldRange(fold(1, [leaf(2, 2, 5)])), { start: 3, end: 5 });
  assert.equal(
    nativeFoldRange({ id: 1, kind: "fold", start: { line: 2, column: 1 }, end: { line: 2, column: 8 }, children: [] }),
    undefined,
  );
});

test("change paint comes from changed spans: lines with a span tint, spans paint", () => {
  const diff: StructuralTextDiff = {
    type: "text",
    stats,
    lhs: text(["a", "b"], [leaf(1, 0, 1), leaf(2, 1, 2, { changed: [{ line: 1, start_column: 0, end_column: 1 }] })]),
    rhs: text(["a", "b + é"], [leaf(1, 0, 1), leaf(2, 1, 2, { changed: [{ line: 1, start_column: 2, end_column: 6 }] })]),
  };
  const paint = structuralHighlights(diff);
  assert.deepEqual(paint.originalLines, [2]);
  assert.deepEqual(paint.modifiedLines, [2]);
  assert.deepEqual(paint.modified, [{ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }]);
});

test("folds and collapsed leaves share one folding model", () => {
  const gap = leaf(2, 1, 3, { tags: ["unchanged"], visibility: { collapsed: true, label: "2 unchanged lines" } });
  const body = fold(4, [leaf(5, 3, 4), leaf(6, 4, 6)]);
  const regions = structuralFoldingRegions([leaf(1, 0, 1), gap, body, leaf(7, 6, 7)]);
  assert.deepEqual(regions.map((region) => region.id), [2, 4]);
});

test("a collapsed leaf folds under the line above it and hides exactly its lines", () => {
  const collapsed = { collapsed: true, label: "unchanged" };
  // A gap that starts on a fold's header line keeps that line and one more; the gap after a gap keeps its first line.
  const parser = [
    leaf(0, 0, 1376, { visibility: collapsed }),
    fold(1, [leaf(2, 1376, 1460, { visibility: collapsed }), fold(3, [leaf(4, 1460, 1467, { visibility: collapsed }), leaf(5, 1467, 1468)])]),
    leaf(6, 1468, 1470),
    fold(7, [leaf(8, 1470, 1472), leaf(9, 1472, 1473)]),
    leaf(11, 1473, 2171, { visibility: collapsed }),
  ];
  const ranges = structuralFoldRanges(parser).map((entry) => entry.range);
  assert.deepEqual(ranges, [
    { start: 1, end: 1376 },
    { start: 1377, end: 1468 },
    { start: 1378, end: 1460 },
    { start: 1461, end: 1468 },
    { start: 1462, end: 1467 },
    { start: 1471, end: 1473 },
    // The line above this gap is the last line of the previous fold, so the gap keeps its first line.
    { start: 1474, end: 2171 },
  ]);
  assertFoldRangesNest(ranges);
  // Lines 2..40 (0-based) hide behind 1-based line 2, the line above the gap.
  const gap = leaf(1, 2, 40, { visibility: collapsed });
  assert.deepEqual(structuralFoldRanges([leaf(0, 0, 2), gap, leaf(2, 40, 41)]).map((entry) => [entry.region.id, entry.range]), [
    [1, { start: 2, end: 40 }],
  ]);
  // At the top of the file there is no line above: the first gap line stays visible.
  assert.deepEqual(structuralFoldRanges([leaf(1, 0, 60, { visibility: collapsed }), leaf(2, 60, 61)]).map((entry) => entry.range), [
    { start: 1, end: 60 },
  ]);
  // Right under a fold's header the two ranges would share a start line, so the gap keeps its first line too.
  const body = fold(3, [leaf(4, 5, 6), leaf(5, 6, 30, { visibility: collapsed }), leaf(6, 30, 31)]);
  assert.deepEqual(structuralFoldRanges([leaf(0, 0, 5), body]).map((entry) => [entry.region.id, entry.range]), [
    [3, { start: 6, end: 31 }],
    [5, { start: 7, end: 30 }],
  ]);
  // A fold keeps its own first line as the header.
  assert.deepEqual(nativeFoldRange(fold(9, [leaf(10, 2, 5)])), { start: 3, end: 5 });
  // A gap sharing its first line with the previous fold's last line (a fold ending mid-line) starts after that fold.
  const tailLast = leaf(14, 166, 168);
  tailLast.end = { line: 167, column: 5 };
  const tail = fold(12, [leaf(13, 165, 166), tailLast]);
  tail.end = { line: 167, column: 5 };
  const shared: StructuralRegion = { id: 15, kind: "leaf", start: { line: 167, column: 5 }, end: { line: 170, column: 0 }, visibility: collapsed };
  assert.deepEqual(structuralFoldRanges([leaf(0, 0, 165), tail, shared]).map((entry) => entry.range), [
    { start: 166, end: 168 },
    { start: 169, end: 170 },
  ]);
  // A gap that begins on its parent's header line, with a free line above, still stays inside the parent.
  const onHeader = fold(20, [leaf(21, 78, 81, { visibility: collapsed }), leaf(22, 81, 88)]);
  assert.deepEqual(structuralFoldRanges([leaf(19, 77, 78), onHeader]).map((entry) => entry.range), [
    { start: 79, end: 88 },
    { start: 80, end: 81 },
  ]);
  // A child fold that runs past its parent (a wire bug) is clamped to the parent rather than breaking folding.
  const child = fold(31, [leaf(32, 167, 168), leaf(33, 168, 170)]);
  const parent = fold(30, [leaf(34, 165, 167), child]);
  parent.end = { line: 167, column: 8 };
  assert.deepEqual(structuralFoldRanges([leaf(29, 0, 165), parent]).map((entry) => entry.range), [
    { start: 166, end: 168 },
  ]);
});

test("Tree-sitter byte offsets convert to Monaco UTF-16 columns", () => {
  assert.equal(utf16Column("a😀éz", 7), 5);
  assert.throws(() => utf16Column("a😀éz", 2), /UTF-8 boundary/);
});

test("header counts follow what is visible: collapsed regions hide their changed lines", () => {
  const span = (line: number) => ({ line, start_column: 0, end_column: 1 });
  const body = fold(3, [leaf(4, 2, 3), leaf(5, 3, 5, { changed: [span(3), span(4)] }), leaf(6, 5, 6)]);
  const diff: StructuralTextDiff = {
    type: "text",
    stats: { textual: { added: 3, removed: 1 }, visible: { added: 1, removed: 3 } },
    lhs: text(["a", "b", "c", "d", "e", "f"], [leaf(1, 0, 1, { changed: [span(0)] }), leaf(2, 1, 2), body]),
    rhs: text(["a", "x", "c", "d", "e", "f"], [leaf(1, 0, 1, { changed: [span(0)] }), leaf(2, 1, 2), body]),
  };
  assert.deepEqual(structuralInitialCounts(diff).visible, { added: 1, removed: 3 });
  assert.throws(
    () => structuralInitialCounts({ ...diff, stats: { textual: diff.stats.textual } as StructuralTextDiff["stats"] }),
    /without visible counts/,
  );
  const open = structuralVisibleCounts(diff, () => false);
  assert.deepEqual(open.visible, { added: 3, removed: 3 });
  const folded = structuralVisibleCounts(diff, (side, id) => side === 1 && id === 3);
  assert.deepEqual(folded.visible, { added: 1, removed: 3 });
  assert.equal(structuralCountsTooltip(folded), "visible +1 −3\ntextual +3 −1");
  assert.equal(
    structuralCountsTooltip({ ...folded, fallback: { code: "unsupported_language", message: "no grammar" } }),
    "visible +1 −3\ntextual +3 −1\nline diff: unsupported_language",
  );
});

test("six thousand nested regions still yield ranges Monaco accepts", () => {
  const collapsed = { collapsed: true, label: "unchanged" };
  const regions: StructuralRegion[] = [];
  let line = 0, id = 0;
  // 1500 functions, each holding a gap, a changed leaf, and a nested block with its own gap: 6000 regions.
  for (let i = 0; i < 1500; i++) {
    const inner = fold(id++, [leaf(id++, line + 3, line + 4), leaf(id++, line + 4, line + 9, { visibility: collapsed })]);
    regions.push(fold(id++, [leaf(id++, line, line + 1), leaf(id++, line + 1, line + 3, { visibility: collapsed }), inner, leaf(id++, line + 9, line + 10)]));
    line += 10;
  }
  const ranges = structuralFoldRanges(regions).map((entry) => entry.range);
  assert.equal(ranges.length, 6000);
  // A group that begins on its first body's line yields that body's range to the group.
  const body = fold(1, [leaf(2, 10, 11), leaf(3, 11, 20)], ["body", "test"]);
  const group = fold(4, [body, leaf(5, 20, 21)], ["group"]);
  group.visibility = { collapsed: true, label: "1 test body" };
  assert.deepEqual(structuralFoldRanges([group]).map((entry) => [entry.region.id, entry.range]), [[4, { start: 11, end: 21 }]]);
  assertFoldRangesNest(ranges);
  assert.throws(() => assertFoldRangesNest([{ start: 1, end: 10 }, { start: 5, end: 12 }]), /straddles/);
  assert.throws(() => assertFoldRangesNest([{ start: 1, end: 10 }, { start: 1, end: 4 }]), /start on line 1/);
});

test("collapsed labels plan an inline note for one line and a view zone under the header for pseudocode", () => {
  const pseudocode = "// pseudocode\nif not key: return None\nreturn call(key)";
  const fn = fold(1, [leaf(2, 46, 47), leaf(3, 47, 70)], ["body", "function"]);
  fn.visibility = { collapsed: true, label: pseudocode };
  const group = fold(4, [leaf(5, 80, 81), leaf(6, 81, 95)], ["group"]);
  group.visibility = { collapsed: true, label: "5 test bodies" };
  const plan = structuralLabelPlan(structuralFoldRanges([fn, group]));
  assert.deepEqual(plan.zones, [{ id: 1, afterLineNumber: 47, heightInLines: 3, text: pseudocode }]);
  assert.deepEqual(plan.inline, [{ line: 81, text: " 5 test bodies" }]);
});
