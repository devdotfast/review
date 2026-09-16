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

/**
 * Heights are zero for folded lines. Visible paired lines remain anchors, and a run of rows folded on
 * both sides also bounds a segment: the filler a segment needs sits after its last line, so it must not
 * reach past the fold, or it lands beside or below the band that stands in for the folded rows.
 */
export function projectSourceAlignment(
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
	for (const [l, r] of rows) {
		const lh = l === null ? 0 : leftHeight(l);
		const rh = r === null ? 0 : rightHeight(r);
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
