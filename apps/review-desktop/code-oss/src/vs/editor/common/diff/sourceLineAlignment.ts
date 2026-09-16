/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SourceAlignmentSegment {
	leftStart: number;
	leftEnd: number;
	rightStart: number;
	rightEnd: number;
	leftHeight: number;
	rightHeight: number;
}


/** Both layouts measure the same authoritative rows after the editor applies hidden areas. */
function* visibleSourceRows(
 rows: readonly (readonly [number | null, number | null])[],
 leftHeight: (line: number) => number,
 rightHeight: (line: number) => number,
) {
 for (const [l, r] of rows) yield { l, r, lh: l === null ? 0 : leftHeight(l), rh: r === null ? 0 : rightHeight(r) };
}

/**
 * Heights are zero for folded lines. Visible paired lines remain anchors, and a run of rows folded on
 * both sides also bounds a segment: the filler a segment needs sits after its last line, so it must not
 * reach past the fold, or it lands beside or below the band that stands in for the folded rows.
 */
export function projectSplitSourceAlignment(
	rows: readonly (readonly [number | null, number | null])[],
	leftHeight: (line: number) => number,
	rightHeight: (line: number) => number,
): SourceAlignmentSegment[] {
	const result: SourceAlignmentSegment[] = [];
	let left = 0, right = 0, startLeft = 0, startRight = 0, heightLeft = 0, heightRight = 0, previousVisible = true;
	const flush = () => {
		if (left === startLeft && right === startRight) return;
		result.push({ leftStart: startLeft, leftEnd: left, rightStart: startRight, rightEnd: right, leftHeight: heightLeft, rightHeight: heightRight });
		startLeft = left; startRight = right; heightLeft = heightRight = 0;
	};
	for (const { l, r, lh, rh } of visibleSourceRows(rows, leftHeight, rightHeight)) {
		const visible = lh > 0 || rh > 0;
		if ((l !== null && r !== null && lh > 0 && rh > 0) || visible !== previousVisible) flush();
		previousVisible = visible;
		if (l !== null) left = l + 1;
		if (r !== null) right = r + 1;
		heightLeft += lh; heightRight += rh;
	}
	flush();
	return result;
}

/** Inline presentation follows the supplied correspondence; it never aligns two hidden columns.
 * Only visible changed runs need original-code zones. Hidden rows end a run so a zone cannot
 * straddle a collapsed band. The modified model supplies all other visible lines directly.
 */
export function projectInlineSourceAlignment(
 rows: readonly (readonly [number | null, number | null])[],
 leftHeight: (line: number) => number,
 rightHeight: (line: number) => number,
 changedLeft: ReadonlySet<number>,
 changedRight: ReadonlySet<number>,
): SourceAlignmentSegment[] {
 const result: SourceAlignmentSegment[] = [];
 let left = 0, right = 0;
 let run: SourceAlignmentSegment | undefined;
 const flush = () => { if (run) result.push(run); run = undefined; };
 for (const { l, r, lh, rh } of visibleSourceRows(rows, leftHeight, rightHeight)) {
  const changed = l === null || r === null || changedLeft.has(l) || changedRight.has(r);
  if (!changed || (lh === 0 && rh === 0)) flush();
  else {
   run ??= { leftStart: left, leftEnd: left, rightStart: right, rightEnd: right, leftHeight: 0, rightHeight: 0 };
   run.leftHeight += lh; run.rightHeight += rh;
  }
  if (l !== null) left = l + 1;
  if (r !== null) right = r + 1;
  if (run) { run.leftEnd = left; run.rightEnd = right; }
 }
 flush();
 return result;
}
