/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { projectSourceAlignment } from "../../editor/common/diff/sourceLineAlignment.js";
import {
  collapsedRegions,
  hiddenLinesOf,
  structuralContextGaps,
  bandDetail,
  structuralCountsTooltip,
  structuralInitialCounts,
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

test("a collapsed fold hides the lines after its signature; a collapsed leaf hides every line; nested collapses are subsumed", () => {
  const collapsed = { collapsed: true, label: "x" };
  const inner = fold(3, [leaf(4, 3, 4), leaf(5, 4, 6)]);
  inner.visibility = collapsed;
  const body = fold(2, [leaf(6, 2, 3), inner, leaf(7, 6, 8)]);
  body.visibility = collapsed;
  assert.deepEqual(hiddenLinesOf(body), { start: 3, end: 8 });
  assert.deepEqual(hiddenLinesOf(leaf(1, 0, 2, { visibility: collapsed })), { start: 0, end: 2 });
  assert.deepEqual(collapsedRegions([leaf(1, 0, 2, { visibility: collapsed }), body], (id) => id === 1 || id === 2 || id === 3).map((r) => r.id), [1, 2]);
  assert.deepEqual(collapsedRegions([leaf(1, 0, 2), body], (id) => id === 3).map((r) => r.id), [3]);
});

test("every collapsed region becomes a labelled band: paired by id, or one-sided at the aligned line", () => {
  const pseudocode = "// pseudocode\nif not key: return None\nreturn call(key)";
  const gapL = leaf(1, 0, 40, { tags: ["unchanged"], visibility: { collapsed: true, label: "40 unchanged lines" } });
  const gapR = leaf(1, 0, 40, { tags: ["unchanged"], visibility: { collapsed: true, label: "40 unchanged lines" } });
  const removed = fold(2, [leaf(3, 40, 41), leaf(4, 41, 60)], ["body", "function"]);
  removed.visibility = { collapsed: true, label: "19 lines removed" };
  const added = fold(5, [leaf(6, 40, 41), leaf(7, 41, 70)], ["body", "function"]);
  added.visibility = { collapsed: true, label: pseudocode };
  const tailL = leaf(8, 60, 62), tailR = leaf(8, 70, 72);
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
  const diff: StructuralTextDiff = {
    type: "text",
    stats,
    lhs: text(lines(62), [gapL, removed, tailL]),
    rhs: text(lines(72), [gapR, added, tailR]),
  };
  const gaps = structuralContextGaps(diff, (_side, id) => id === 1 || id === 2 || id === 5);
  assert.deepEqual(gaps, [
    { originalStart: 1, originalCount: 40, modifiedStart: 1, modifiedCount: 40, label: "40 unchanged lines", kind: "unchanged", collapsed: true, ids: { lhs: 1, rhs: 1 } },
    // The removed body hides lines 42..60 on the left; its rows precede the added body's, so it anchors before them on the right.
    { originalStart: 42, originalCount: 19, modifiedStart: 41, modifiedCount: 0, label: "19 lines removed", kind: "removed", collapsed: true, ids: { lhs: 2 } },
    { originalStart: 61, originalCount: 0, modifiedStart: 42, modifiedCount: 29, label: pseudocode, kind: "inserted", collapsed: true, ids: { rhs: 5 } },
  ]);
  // A region the reader revealed stays a band, marked open, so the editor keeps a fold control on it.
  const revealed = structuralContextGaps(diff, (_side, id) => id === 2 || id === 5, (_side, id) => (id === 1 ? false : id === 2 || id === 5 ? true : undefined));
  assert.deepEqual(revealed.map((g) => [g.ids, g.collapsed]), [[{ lhs: 1, rhs: 1 }, false], [{ lhs: 2 }, true], [{ rhs: 5 }, true]]);
  // A region the state never knew is not a band at all.
  assert.deepEqual(structuralContextGaps(diff, (_side, id) => id === 2 || id === 5).map((g) => g.ids), [{ lhs: 2 }, { rhs: 5 }]);
  // A collapsed region without a label is named by its line count.
  const unlabeled = leaf(9, 0, 3, { visibility: { collapsed: true, label: "" } });
  const small: StructuralTextDiff = { type: "text", stats, lhs: text(lines(3), [unlabeled]), rhs: text(lines(3), [unlabeled]) };
  assert.equal(structuralContextGaps(small, () => true)[0].label, "3 hidden lines");
});

test("a band's detail drops diffr's pseudocode marker line and keeps one-line labels empty", () => {
  assert.equal(bandDetail("// pseudocode\nx = 1\n  y = 2"), "x = 1\n  y = 2");
  assert.equal(bandDetail("# pseudocode\nreturn x"), "return x");
  assert.equal(bandDetail("first\nsecond"), "first\nsecond");
  assert.equal(bandDetail("19 lines removed"), "");
});
