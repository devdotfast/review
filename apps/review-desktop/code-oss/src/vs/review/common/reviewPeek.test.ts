/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	reviewPeekCappedHeight,
	reviewPeekDiffWindows,
	reviewPeekDiffWindowsRenderedHeights,
	reviewPeekMultiDiffBodyHeightLimit,
	reviewPeekWindowsRenderedHeight,
} from './reviewPeek.js';

test('includes comment view zones in rendered peek height', () => {
	const calls: Array<[kind: 'top' | 'bottom', includeViewZones: boolean | undefined]> = [];
	const height = reviewPeekWindowsRenderedHeight({
		getModel: () => ({}),
		getTopForLineNumber: (_lineNumber, includeViewZones) => {
			calls.push(['top', includeViewZones]);
			return 40;
		},
		getBottomForLineNumber: (_lineNumber, includeViewZones) => {
			calls.push(['bottom', includeViewZones]);
			return includeViewZones ? 260 : 140;
		},
	}, [{ startLine: 3, endLine: 7, lineCount: 5, visibleLineCount: 5, height: 100 }]);

	assert.equal(height, 220);
	assert.deepEqual(calls, [['top', true], ['bottom', true]]);
});

test('added file excerpts exclude the absent base side\'s full-file alignment spacer', () => {
	const windows = reviewPeekDiffWindows(
		1,
		901,
		[{ startLine: 247, endLine: 278 }],
		'head',
		[{
			originalStartLine: 1, originalEndLineExclusive: 1,
			modifiedStartLine: 1, modifiedEndLineExclusive: 901,
		}],
	);
	const placeholder = renderedEditor(18_000);
	// The 38 visible lines include context. Wrapping and a real comment
	// composer still increase the selected side's measured height.
	const source = renderedEditor(800, 160);
	const heights = reviewPeekDiffWindowsRenderedHeights(
		placeholder,
		source,
		windows.original,
		windows.modified,
		'added',
	);
	assert.equal(Math.max(heights.original ?? 0, heights.modified ?? 0), 960);
	assert.equal(heights.original, undefined);
	assert.equal(reviewPeekCappedHeight(960, 160), 520);
	assert.equal(reviewPeekMultiDiffBodyHeightLimit('content', windows.original, windows.modified, 'added'), 760);
	assert.equal(reviewPeekMultiDiffBodyHeightLimit('capped', windows.original, windows.modified, 'added'), 360);
});

test('two real diff sides retain their code and in-window comment space', () => {
	const window = [{ startLine: 3, endLine: 7, lineCount: 5, visibleLineCount: 5, height: 100 }];
	const heights = reviewPeekDiffWindowsRenderedHeights(
		renderedEditor(180, 160), renderedEditor(220), window, window, 'modified',
	);
	assert.equal(heights.original, 340);
	assert.equal(heights.modified, 220);
	assert.equal(reviewPeekMultiDiffBodyHeightLimit('content', window, window, 'modified'), 200);
});

test('deleted files preserve code rendered in the modified-side diff view zone', () => {
	const window = [{ startLine: 1, endLine: 1, lineCount: 1, visibleLineCount: 1, height: 20 }];
	const heights = reviewPeekDiffWindowsRenderedHeights(
		renderedEditor(100), renderedEditor(0, 760), window, window, 'deleted',
	);
	assert.equal(Math.max(heights.original ?? 0, heights.modified ?? 0), 760);
});

test('an unresolved source model falls back to the bounded source window', () => {
	const window = [{ startLine: 3, endLine: 7, lineCount: 5, visibleLineCount: 5, height: 100 }];
	const heights = reviewPeekDiffWindowsRenderedHeights(
		renderedEditor(18_000), { ...renderedEditor(100), getModel: () => null }, window, window, 'added',
	);
	assert.equal(heights.original, undefined);
	assert.equal(heights.modified, undefined);
	assert.equal(reviewPeekMultiDiffBodyHeightLimit('content', window, window, 'added'), 100);
});

function renderedEditor(codeHeight: number, commentHeight = 0) {
	return {
		getModel: () => ({}),
		getTopForLineNumber: () => 40,
		getBottomForLineNumber: (_line: number, includeViewZones?: boolean) => 40 + codeHeight + (includeViewZones ? commentHeight : 0),
	};
}
