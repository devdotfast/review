/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IDocumentDiff, IDocumentContextGap } from '../../editor/common/diff/documentDiffProvider.js';
import type { ReviewDiffLens } from './reviewProtocol.js';

/** Project pinned ranges onto the current diff's correspondence, never onto another revision. */
export function lensContextGaps(diff: IDocumentDiff, originalCount: number, modifiedCount: number, ranges: ReviewDiffLens['ranges']): IDocumentContextGap[] {
	const rows = alignmentRows(diff, originalCount, modifiedCount);
	const visible = rows.map(row => ranges.some(range => {
		const line = row[range.side === 'base' ? 0 : 1];
		return line !== null && line + 1 >= range.fromLine && line + 1 <= range.toLine;
	}));
	// Context follows alignment rows, keeping both sides synchronized around insertions.
	const context = visible.map((_, index) => visible.slice(Math.max(0, index - 3), index + 4).some(Boolean));
	if (diff.contextScopes) {
		// A lens must not clip context that diffr kept around its selected code.
		// Seed enclosing scope boundaries, then retain each visible context run
		// touching a seed. Never expand through a collapsed provider band.
		const scopes = [diff.contextScopes.original, diff.contextScopes.modified];
		const enclosing = scopes.map((sideScopes, side) => sideScopes.filter(([start, end]) =>
			rows.some((row, index) => visible[index] && row[side] !== null && row[side]! >= start && row[side]! < end)));
		const open = rows.map(row => row.every((line, side) => line === null || !(diff.contextGaps ?? []).some(gap => {
			if (gap.collapsed === false) return false;
			const start = side === 0 ? gap.originalStart : gap.modifiedStart;
			const count = side === 0 ? gap.originalCount : gap.modifiedCount;
			return line + 1 >= start && line + 1 < start + count;
		})));
		const seeds = rows.map((row, index) => visible[index] || row.some((line, side) =>
			line !== null && enclosing[side].some(([start, end]) => line === start || line === end - 1)));
		for (let start = 0; start < rows.length;) {
			if (!open[start]) { start++; continue; }
			let end = start + 1;
			while (end < rows.length && open[end]) end++;
			if (seeds.slice(start, end).some(Boolean)) context.fill(true, start, end);
			start = end;
		}
	}
	const gaps: IDocumentContextGap[] = [];
	let left = 1, right = 1;
	for (let index = 0; index < rows.length;) {
		if (context[index]) { if (rows[index][0] !== null) left++; if (rows[index][1] !== null) right++; index++; continue; }
		const originalStart = left, modifiedStart = right;
		while (index < rows.length && !context[index]) { if (rows[index][0] !== null) left++; if (rows[index][1] !== null) right++; index++; }
		gaps.push({
			originalStart, modifiedStart, originalCount: left - originalStart, modifiedCount: right - modifiedStart, label: 'Outside lens', breadcrumbs: false,
			owner: left === originalStart ? 'head' : right === modifiedStart ? 'base' : 'both', change: gapChange(diff, originalStart, left, modifiedStart, right)
		});
	}
	// Keep structural folds only when fully within the visible slice; no overlapping bands.
	const overlap = (a: IDocumentContextGap, b: IDocumentContextGap) =>
		(a.originalCount > 0 && b.originalCount > 0 && a.originalStart < b.originalStart + b.originalCount && b.originalStart < a.originalStart + a.originalCount) ||
		(a.modifiedCount > 0 && b.modifiedCount > 0 && a.modifiedStart < b.modifiedStart + b.modifiedCount && b.modifiedStart < a.modifiedStart + a.modifiedCount);
	return [...gaps, ...(diff.contextGaps ?? []).filter(gap => !gaps.some(hidden => overlap(gap, hidden)))].sort((a, b) => a.originalStart - b.originalStart || a.modifiedStart - b.modifiedStart);
}

export function alignmentRows(diff: IDocumentDiff, originalCount: number, modifiedCount: number): (readonly [number | null, number | null])[] {
	const rows: (readonly [number | null, number | null])[] = [];
	if (diff.sourceLineAlignment) return diff.sourceLineAlignment.slice();
	else {
		let left = 0, right = 0;
		const append = (leftEnd: number, rightEnd: number) => {
			while (left < leftEnd || right < rightEnd) rows.push([left < leftEnd ? left++ : null, right < rightEnd ? right++ : null]);
		};
		for (const change of diff.changes) {
			append(change.original.startLineNumber - 1, change.modified.startLineNumber - 1);
			append(change.original.endLineNumberExclusive - 1, change.modified.endLineNumberExclusive - 1);
		}
		append(originalCount, modifiedCount);
	}
	return rows;
}

/** A paired row folds only when none of its changed lines remain unread. */
export function viewedContextGaps(diff: IDocumentDiff, originalCount: number, modifiedCount: number, viewed: ReviewDiffLens['ranges'], changed: ReviewDiffLens['ranges']): IDocumentContextGap[] {
	const rows = alignmentRows(diff, originalCount, modifiedCount);
	const contains = (ranges: ReviewDiffLens['ranges'], side: 0 | 1, line: number) => ranges.some(range => range.side === (side === 0 ? 'base' : 'head') && line + 1 >= range.fromLine && line + 1 <= range.toLine);
	const hidden = rows.map(row => row.some((line, side) => line !== null && contains(viewed, side as 0 | 1, line)) && row.every((line, side) => line === null || !contains(changed, side as 0 | 1, line) || contains(viewed, side as 0 | 1, line)));
	const gaps: IDocumentContextGap[] = [];
	let left = 1, right = 1;
	for (let index = 0; index < rows.length;) {
		if (!hidden[index]) { if (rows[index][0] !== null) left++; if (rows[index][1] !== null) right++; index++; continue; }
		const originalStart = left, modifiedStart = right;
		while (index < rows.length && hidden[index]) { if (rows[index][0] !== null) left++; if (rows[index][1] !== null) right++; index++; }
		gaps.push({ originalStart, modifiedStart, originalCount: left - originalStart, modifiedCount: right - modifiedStart, label: 'Viewed', breadcrumbs: false, owner: left === originalStart ? 'head' : right === modifiedStart ? 'base' : 'both', change: gapChange(diff, originalStart, left, modifiedStart, right) });
	}
	const overlaps = (a: IDocumentContextGap, b: IDocumentContextGap) =>
		(a.originalCount > 0 && b.originalCount > 0 && a.originalStart < b.originalStart + b.originalCount && b.originalStart < a.originalStart + a.originalCount) ||
		(a.modifiedCount > 0 && b.modifiedCount > 0 && a.modifiedStart < b.modifiedStart + b.modifiedCount && b.modifiedStart < a.modifiedStart + a.modifiedCount);
	return [...gaps, ...(diff.contextGaps ?? []).filter(gap => !gaps.some(viewed => overlaps(gap, viewed)))].sort((a, b) => a.originalStart - b.originalStart || a.modifiedStart - b.modifiedStart);
}

/** Lens and viewed folds describe coverage, not a new diff; retain the provider's change status. */
function gapChange(diff: IDocumentDiff, originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number): NonNullable<IDocumentContextGap['change']> {
	const removed = diff.sourceLineAlignment?.some(([l, r]) => r === null && l !== null && l + 1 >= originalStart && l + 1 < originalEnd) || diff.changes.some(c => originalStart < originalEnd && !c.original.isEmpty && c.original.startLineNumber < originalEnd && c.original.endLineNumberExclusive > originalStart);
	const added = diff.sourceLineAlignment?.some(([l, r]) => l === null && r !== null && r + 1 >= modifiedStart && r + 1 < modifiedEnd) || diff.changes.some(c => modifiedStart < modifiedEnd && !c.modified.isEmpty && c.modified.startLineNumber < modifiedEnd && c.modified.endLineNumberExclusive > modifiedStart);
	return removed && added ? 'modified' : removed ? 'removed' : added ? 'inserted' : 'unchanged';
}
