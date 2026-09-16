/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { projectInlineSourceAlignment, projectSplitSourceAlignment } from "../../editor/common/diff/sourceLineAlignment.js";
import {
	collapsedRegions,
	hiddenLinesOf,
	structuralContextGaps,
	bandDetail,
	structuralHighlights,
	structuralRows,
	utf16Column,
	type StructuralFold,
	type StructuralLeaf,
	type StructuralRegion,
	type StructuralTextDiff,
} from "./reviewStructuralDiff.js";

/**
 * A leaf whose `id`, `alignment_id` and `fold_state_id` are all `id`. Tests pair two leaves by giving
 * them one number on both sides, which repeats the `id` across sides as diffr never does; nothing here
 * keys identity across sides, and the tests that tell the ids apart set them through `extra`.
 */
function leaf(id: number, start: number, end: number, extra: Partial<StructuralLeaf> = {}): StructuralLeaf {
	return { id, alignment_id: id, fold_state_id: id, kind: "leaf", start: { line: start, column: 0 }, end: { line: end, column: 0 }, ...extra };
}
function fold(id: number, children: StructuralRegion[], tags: string[] = ["context:body"]): StructuralFold {
	const first = children[0], last = children[children.length - 1];
	return { id, fold_state_id: id, kind: "fold", start: first.start, end: last.end, tags, children };
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
	const segments = projectSplitSourceAlignment(
		rows,
		(l) => (l === 1 || l === 2 ? 0 : 20),
		(r) => (r >= 1 && r <= 3 ? 0 : 20),
	);
	assert.deepEqual(
		segments.map((s) => [s.leftEnd, s.rightEnd, s.rightHeight - s.leftHeight]),
		[
			[1, 1, 0],
			[3, 4, 0],
			[4, 5, 0],
		],
	);
});

test("a one-sided band's height is filled on the other side at the row that starts the fold, not past it", () => {
	// Right-only row 1, then a right fold (rows 2..4) whose band is 50px and whose middle row pairs with left 1, then right-only row 5.
	const rows: [number | null, number | null][] = [
		[0, 0],
		[null, 1],
		[null, 2],
		[1, 3],
		[null, 4],
		[null, 5],
		[2, 6],
	];
	const segments = projectSplitSourceAlignment(
		rows,
		(l) => (l === 1 ? 0 : 20),
		(r) => (r === 2 ? 50 : r === 3 || r === 4 ? 0 : 20),
	);
	// Fillers sit after a segment's last left line: after left 0 for row 1 and the band, then again after left 0 (left 1 is folded) for row 5.
	assert.deepEqual(
		segments.map((s) => [s.leftEnd, s.rightEnd, s.rightHeight - s.leftHeight]),
		[
			[1, 3, 70],
			[2, 5, 0],
			[2, 6, 20],
			[3, 7, 0],
		],
	);
});

test("leaves zip by alignment_id into rows: paired line for line, unpaired one-sided, trailing empty lines paired", () => {
	// As diffr numbers them: every region has its own id; paired leaves share alignment and fold state.
	const rhsLeaf = (id: number, alignment: number, start: number, end: number) =>
		leaf(id, start, end, { alignment_id: alignment, fold_state_id: alignment === 9 ? id : alignment - 1 });
	const diff: StructuralTextDiff = {
		type: "text", structural_changes: { base: [], head: [] },
		stats,
		lhs: text(["a", "b", "c", "d"], [leaf(0, 0, 1, { alignment_id: 1 }), leaf(1, 1, 2, { alignment_id: 2 }), leaf(2, 2, 4, { alignment_id: 3 })]),
		rhs: text(["a", "x", "b", "c", "d"], [rhsLeaf(3, 1, 0, 1), rhsLeaf(4, 9, 1, 2), rhsLeaf(5, 2, 2, 3), rhsLeaf(6, 3, 3, 5)]),
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

test("one-sided files and nested folds still tile", () => {
	const added: StructuralTextDiff = {
		type: "text", structural_changes: { base: [], head: [] },
		stats,
		rhs: text(["fn f() {", "  1", "}"], [fold(1, [leaf(2, 0, 1), leaf(3, 1, 2), leaf(4, 2, 3)])]),
	};
	assert.deepEqual(structuralRows(added), [
		[null, 0],
		[null, 1],
		[null, 2],
		[null, 3],
	]);
});


test("structural coverage tints inserted lines without novel tokens, retaining UTF-16 token highlights", () => {
	const diff: StructuralTextDiff = {
		type: "text", structural_changes: { base: [[1, 2]], head: [[1, 4]] },
		stats,
		lhs: text(["a", "b"], [leaf(1, 0, 1), leaf(2, 1, 2, { changed: [{ line: 1, start_column: 0, end_column: 1 }] })]),
		rhs: text(["a", "b + é", "", "}"], [leaf(1, 0, 1), leaf(3, 1, 4, { changed: [{ line: 1, start_column: 2, end_column: 6 }] })]),
	};
	const paint = structuralHighlights(diff);
	assert.deepEqual(paint.originalLines, [2]);
	assert.deepEqual(paint.modifiedLines, [2, 3, 4]);
	assert.deepEqual(paint.modified, [{ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }]);
});

test("fully novel lines retain line tint without token tint on either side", () => {
	for (const changed of [
		[{ line: 0, start_column: 0, end_column: 13 }],
		[{ line: 0, start_column: 1, end_column: 12 }],
		[{ line: 0, start_column: 1, end_column: 6 }, { line: 0, start_column: 7, end_column: 12 }],
	]) {
		const source = text(["\tconst café \t"], [leaf(1, 0, 1, { changed })]);
		const paint = structuralHighlights({ type: "text", stats, structural_changes: { base: [[0, 1]], head: [[0, 1]] }, lhs: source, rhs: source });
		assert.deepEqual(paint.originalLines, [1]);
		assert.deepEqual(paint.modifiedLines, [1]);
		assert.deepEqual(paint.original, []);
		assert.deepEqual(paint.modified, []);
	}
});

test("Tree-sitter byte offsets convert to Monaco UTF-16 columns", () => {
	assert.equal(utf16Column("a😀éz", 7), 5);
});


test("a collapsed region hides every line it covers, fold or leaf; nested collapses are subsumed", () => {
	const collapsed = { collapsed: true, label: "x" };
	const inner = fold(3, [leaf(4, 3, 4), leaf(5, 4, 6)]);
	inner.visibility = collapsed;
	const body = fold(2, [leaf(6, 2, 3), inner, leaf(7, 6, 8)]);
	body.visibility = collapsed;
	assert.deepEqual(hiddenLinesOf(body), { start: 2, end: 8 });
	assert.deepEqual(hiddenLinesOf(leaf(1, 0, 2, { visibility: collapsed })), { start: 0, end: 2 });
	assert.deepEqual(collapsedRegions([leaf(1, 0, 2, { visibility: collapsed }), body], (id) => id === 1 || id === 2 || id === 3).map((r) => r.fold_state_id), [1, 2]);
	assert.deepEqual(collapsedRegions([leaf(1, 0, 2), body], (id) => id === 3).map((r) => r.fold_state_id), [3]);
});

test("every collapsed region becomes a labelled band: paired across sides, or one-sided at the aligned line", () => {
	const pseudocode = "// pseudocode\nif not key: return None\nreturn call(key)";
	const gapL = leaf(1, 0, 40, { visibility: { collapsed: true, label: "40 unchanged lines" } });
	// The paired gap has an id of its own and pairs with the left one by alignment.
	const gapR = leaf(11, 0, 40, { alignment_id: 1, fold_state_id: 1, visibility: { collapsed: true, label: "40 unchanged lines" } });
	// A body fold covers the body alone; the signature line is the leaf before it.
	const removed = fold(2, [leaf(4, 41, 60)], ["deleted-bodies:function"]);
	removed.visibility = { collapsed: true, label: "19 lines removed" };
	const added = fold(5, [leaf(7, 41, 70)], ["deleted-bodies:function"]);
	added.visibility = { collapsed: true, label: pseudocode };
	const tailL = leaf(8, 60, 62), tailR = leaf(8, 70, 72);
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
	const diff: StructuralTextDiff = {
		type: "text", structural_changes: { base: [], head: [] },
		stats,
		lhs: text(lines(62), [gapL, leaf(3, 40, 41), removed, tailL]),
		rhs: text(lines(72), [gapR, leaf(6, 40, 41), added, tailR]),
	};
	const gaps = structuralContextGaps(diff, (id) => id === 1 || id === 2 || id === 5);
	assert.deepEqual(gaps, [
		{ originalStart: 1, originalCount: 40, modifiedStart: 1, modifiedCount: 40, label: "40 unchanged lines", owner: "both", change: "unchanged", collapsed: true, foldStateId: 1, breadcrumbs: true },
		// The removed body hides lines 42..60 on the left; its rows precede the added body's, so it anchors before them on the right.
		{ originalStart: 42, originalCount: 19, modifiedStart: 41, modifiedCount: 0, label: "19 lines removed", owner: "base", change: "removed", collapsed: true, foldStateId: 2, breadcrumbs: true },
		{ originalStart: 61, originalCount: 0, modifiedStart: 42, modifiedCount: 29, label: pseudocode, owner: "head", change: "inserted", collapsed: true, foldStateId: 5, breadcrumbs: true },
	]);
	// A region the reader revealed stays a band, marked open, so the editor keeps a fold control on it.
	const revealed = structuralContextGaps(diff, (id) => id === 2 || id === 5, (id) => (id === 1 ? false : id === 2 || id === 5 ? true : undefined));
	assert.deepEqual(revealed.map((g) => [g.foldStateId, g.collapsed]), [[1, false], [2, true], [5, true]]);
	// A region the state never knew is not a band at all, and neither is one that never starts collapsed.
	assert.deepEqual(structuralContextGaps(diff, (id) => id === 2 || id === 5).map((g) => g.foldStateId), [2, 5]);
	assert.deepEqual(structuralContextGaps(diff, () => false, (id) => (id === 8 ? false : id === 2 ? true : undefined)).map((g) => g.foldStateId), [2]);
	// A collapsed region without a label is named by its line count.
	const unlabeled = leaf(9, 0, 3, { visibility: { collapsed: true, label: "" } });
	const small: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text(lines(3), [unlabeled]), rhs: text(lines(3), [unlabeled]) };
	assert.equal(structuralContextGaps(small, () => true)[0].label, "3 hidden lines");
});

test("a band's detail drops diffr's pseudocode marker line and keeps one-line labels empty", () => {
	assert.equal(bandDetail("// pseudocode\nx = 1\n  y = 2"), "x = 1\n  y = 2");
	assert.equal(bandDetail("# pseudocode\nreturn x"), "return x");
	assert.equal(bandDetail("first\nsecond"), "first\nsecond");
	assert.equal(bandDetail("19 lines removed"), "");
});

test("a one-sided band also hides the opposite lines the zip aligned with it", () => {
	// The lhs fold is unpaired (no rhs region shares its fold state), but its body leaf (3) pairs with an rhs leaf: the band spans both.
	const body = fold(2, [leaf(4, 1, 6)], ["deleted-bodies:function"]);
	body.visibility = { collapsed: true, label: "5 unchanged lines" };
	const rhsHead = leaf(3, 0, 1), rhsBody = leaf(4, 1, 6);
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
	const diff: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text(lines(6), [leaf(3, 0, 1), body]), rhs: text(lines(6), [rhsHead, rhsBody]) };
	const [gap] = structuralContextGaps(diff, (id) => id === 2);
	assert.deepEqual(gap, {
		originalStart: 2, originalCount: 5, modifiedStart: 2, modifiedCount: 5,
		label: "5 unchanged lines", owner: "base", change: "unchanged", collapsed: true, foldStateId: 2, breadcrumbs: true,
	});
});

test("a one-sided band starts after the row before its fold and hides only the opposite lines inside its rows", () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
	// Right: a function whose body has an inserted run, a middle leaf paired with the left, and another inserted run.
	const added = fold(20, [leaf(22, 3, 5), leaf(12, 5, 7), leaf(23, 7, 9)], ["deleted-bodies:function"]);
	added.visibility = { collapsed: true, label: "// pseudocode\nreturn rows" };
	const inserted: StructuralTextDiff = {
		type: "text", structural_changes: { base: [], head: [] },
		stats,
		lhs: text(lines(6), [leaf(10, 0, 2), leaf(12, 2, 4), leaf(14, 4, 6)]),
		rhs: text(lines(11), [leaf(10, 0, 2), leaf(21, 2, 3), added, leaf(14, 9, 11)]),
	};
	assert.deepEqual(structuralRows(inserted).slice(0, 10), [
		[0, 0], [1, 1], [null, 2], [null, 3], [null, 4], [2, 5], [3, 6], [null, 7], [null, 8], [4, 9],
	]);
	assert.deepEqual(structuralContextGaps(inserted, (id) => id === 20), [{
		originalStart: 3, originalCount: 2, modifiedStart: 4, modifiedCount: 6,
		label: "// pseudocode\nreturn rows", owner: "head", change: "inserted", collapsed: true, foldStateId: 20, breadcrumbs: true,
	}]);
	// The mirror: a left-only function whose rows are all filler on the right, followed by a right-only line.
	const removed = fold(20, [leaf(22, 3, 6)], ["deleted-bodies:function"]);
	removed.visibility = { collapsed: true, label: "3 lines removed" };
	const deleted: StructuralTextDiff = {
		type: "text", structural_changes: { base: [], head: [] },
		stats,
		lhs: text(lines(8), [leaf(10, 0, 2), leaf(21, 2, 3), removed, leaf(14, 6, 8)]),
		rhs: text(lines(5), [leaf(10, 0, 2), leaf(30, 2, 3), leaf(14, 3, 5)]),
	};
	assert.deepEqual(structuralRows(deleted).slice(0, 8), [[0, 0], [1, 1], [2, null], [3, null], [4, null], [5, null], [null, 2], [6, 3]]);
	assert.deepEqual(structuralContextGaps(deleted, (id) => id === 20), [{
		originalStart: 4, originalCount: 3, modifiedStart: 3, modifiedCount: 0,
		label: "3 lines removed", owner: "base", change: "removed", collapsed: true, foldStateId: 20, breadcrumbs: true,
	}]);
});

test("alignment and fold state are separate: the zip follows one, collapse follows the other", () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
	// A docstring (id 1) linked to its function under fold state 7 on the rhs. The matched
	// functions have their own ids (2 and 5), share fold state 7, and their leaves pair by alignment.
	const doc = { ...leaf(1, 0, 2, { visibility: { collapsed: true, label: "" } }), fold_state_id: 7 };
	const fnR = { ...fold(5, [leaf(4, 3, 6)]), fold_state_id: 7 };
	fnR.visibility = { collapsed: true, label: "3 hidden lines" };
	const fnL = { ...fold(2, [leaf(4, 1, 4)]), fold_state_id: 7 };
	fnL.visibility = { collapsed: true, label: "3 hidden lines" };
	const diff: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text(lines(4), [leaf(3, 0, 1), fnL]), rhs: text(lines(6), [doc, leaf(3, 2, 3), fnR]) };
	// Rows pair the functions' leaves by alignment_id; the docstring is rhs-only.
	assert.deepEqual(structuralRows(diff).slice(0, 3), [[null, 0], [null, 1], [0, 2]]);
	// One toggle, fold state 7, hides both the docstring and the paired function.
	const gaps = structuralContextGaps(diff, (id) => id === 7);
	assert.deepEqual(gaps.map((g) => [g.change, g.foldStateId]).sort(), [["inserted", 7], ["unchanged", 7]]);
	assert.deepEqual(gaps.find((g) => g.change === "unchanged"), {
		originalStart: 2, originalCount: 3, modifiedStart: 4, modifiedCount: 3,
		label: "3 hidden lines", owner: "both", change: "unchanged", collapsed: true, foldStateId: 7, breadcrumbs: true,
	});
	// With fold state 7 open, neither the docstring nor the function is a band.
	assert.deepEqual(structuralContextGaps(diff, () => false), []);
});

test("a docstring bundled with its function shares one fold state and shows a bare count", () => {
	const collapsed = { collapsed: true, label: "" };
	const doc = leaf(30, 0, 2, { tags: ["summarize:docstring"], visibility: collapsed });
	doc.fold_state_id = 40;
	const body = fold(40, [leaf(42, 3, 6)], ["deleted-bodies:function"]);
	body.visibility = { collapsed: true, label: "// pseudocode\nreturn x" };
	const lines = ["/// a", "/// b", "fn f() {", "x", "y", "}"];
	const diff: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text([], []), rhs: text(lines, [doc, leaf(41, 2, 3), body]) };
	const open = new Set<number>();
	const state = (id: number) => (id === 40 ? !open.has(id) : undefined);
	const gaps = structuralContextGaps(diff, (id) => state(id) === true, state);
	assert.deepEqual(gaps.map((g) => [g.foldStateId, g.breadcrumbs, g.collapsed]), [[40, false, true], [40, true, true]]);
	open.add(40);
	assert.deepEqual(structuralContextGaps(diff, (id) => state(id) === true, state).map((g) => g.collapsed), [false, false]);
});

test("a fold pairs through fold state, and a docstring fold only with a docstring fold", () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
	const collapsed = { collapsed: true, label: "" };
	// lhs: a docstring fold (0-3) linked to the function body (3-7). rhs: only the body (0-4), matched with the lhs body.
	const docL: StructuralRegion = { ...fold(1, [leaf(2, 0, 3)], ["deleted-bodies:docstring"]), fold_state_id: 9, visibility: collapsed };
	const bodyL: StructuralRegion = { ...fold(4, [leaf(6, 4, 7)], ["deleted-bodies:function"]), fold_state_id: 9, visibility: { collapsed: true, label: "3 lines" } };
	const bodyR: StructuralRegion = { ...fold(7, [leaf(6, 1, 4)], ["deleted-bodies:function"]), fold_state_id: 9, visibility: { collapsed: true, label: "3 lines" } };
	const diff: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text(lines(7), [docL, leaf(5, 3, 4), bodyL]), rhs: text(lines(4), [leaf(5, 0, 1), bodyR]) };
	const gaps = structuralContextGaps(diff, (id) => id === 9);
	// A whole-node docstring fold covers every line it holds; the body fold starts below
	// the signature leaf beside it.
	assert.deepEqual(gaps.map((g) => [g.change, g.originalStart, g.originalCount, g.modifiedStart, g.modifiedCount, g.breadcrumbs]), [
		["removed", 1, 3, 1, 0, false],
		["unchanged", 5, 3, 2, 3, true],
	]);
	// Folds that share an id but not a fold state are not a pair.
	const other: StructuralRegion = { ...bodyR, id: 4, fold_state_id: 10 };
	const unpaired: StructuralTextDiff = { ...diff, rhs: text(lines(4), [other]) };
	assert.deepEqual(structuralContextGaps(unpaired, (id) => id === 9 || id === 10).map((g) => g.owner).sort(), ["base", "base", "head"]);
});


test("inline correspondence omits a large folded region rather than balancing its hidden sides", () => {
	const rows: [number | null, number | null][] = [[0, 0], ...Array.from({ length: 100 }, (_, i): [number, null] => [i + 1, null]), [101, 1], [102, 2]];
	const result = projectInlineSourceAlignment(rows, l => l > 0 && l < 101 ? 0 : 20, () => 20, new Set([101]), new Set([1]));
	assert.deepEqual(result, [{ leftStart: 101, leftEnd: 102, rightStart: 1, rightEnd: 2, leftHeight: 20, rightHeight: 20 }]);
});

test("inline correspondence retains removed code, changed pairs, and insertion order", () => {
	const rows: [number | null, number | null][] = [[0, 0], [1, null], [null, 1], [2, 2], [3, 3]];
	const result = projectInlineSourceAlignment(rows, () => 20, r => r === 2 ? 40 : 20, new Set([2]), new Set([2]));
	assert.deepEqual(result, [{ leftStart: 1, leftEnd: 3, rightStart: 1, rightEnd: 3, leftHeight: 40, rightHeight: 60 }]);
});

test("a folded changed pair separates inline original-code zones", () => {
	const rows: [number, number][] = [[0, 0], [1, 1], [2, 2]];
	const result = projectInlineSourceAlignment(rows, l => l === 1 ? 0 : 20, r => r === 1 ? 0 : 20, new Set([0, 1, 2]), new Set([0, 1, 2]));
	assert.deepEqual(result.map(s => [s.leftStart, s.leftEnd, s.rightStart, s.rightEnd]), [[0, 1, 0, 1], [2, 3, 2, 3]]);
});


test("base-owned unchanged fold projects both ranges and retains its toggle identity after reveal", () => {
	const base = fold(26, [leaf(16, 0, 1), fold(28, [leaf(17, 1, 4)]), leaf(18, 4, 5)]);
	base.visibility = { collapsed: true, label: "5 unchanged lines" };
	const head = fold(334, [leaf(16, 0, 1), fold(336, [leaf(17, 1, 4)]), leaf(18, 4, 5)]);
	const diff: StructuralTextDiff = { type: "text", structural_changes: { base: [], head: [] }, stats, lhs: text(["a", "b", "c", "d", "e"], [base]), rhs: text(["a", "b", "c", "d", "e"], [head]) };
	for (const collapsed of [true, false, true]) {
		const [gap] = structuralContextGaps(diff, () => collapsed, id => id === 26 ? collapsed : undefined);
		assert.equal(gap.owner, "base"); assert.equal(gap.change, "unchanged");
		assert.equal(gap.originalCount, 5); assert.equal(gap.modifiedCount, 5);
		assert.equal(gap.foldStateId, 26); assert.equal(gap.collapsed, collapsed);
	}
	// Paired leaves with changed spans are modified, regardless of fold ownership.
	const l = base.children[0]; const r = head.children[0];
	if (l.kind !== "leaf" || r.kind !== "leaf") throw new Error("Expected leaves");
	l.changed = [{ line: 0, start_column: 0, end_column: 1 }]; r.changed = [{ line: 0, start_column: 0, end_column: 1 }];
	diff.structural_changes = { base: [[0, 1]], head: [[0, 1]] };
	assert.equal(structuralContextGaps(diff, id => id === 26)[0].change, "modified");
});
