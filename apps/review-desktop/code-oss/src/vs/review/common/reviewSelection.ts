/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewSelectionPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export function reviewSelectionRange(
	start: ReviewSelectionPosition,
	end: ReviewSelectionPosition
): { fromLine: number; toLine: number } {
	let endLine = end.lineNumber;
	if (endLine > start.lineNumber && end.column === 1) {
		endLine -= 1;
	}
	return {
		fromLine: start.lineNumber,
		toLine: Math.max(start.lineNumber, endLine)
	};
}

export function reviewSelectionSide(scheme: string): 'base' | 'head' {
	return scheme === 'devfast-review-base' ? 'base' : 'head';
}
