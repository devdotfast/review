/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewPeekWindowsRenderedHeight } from './reviewPeek.js';

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
