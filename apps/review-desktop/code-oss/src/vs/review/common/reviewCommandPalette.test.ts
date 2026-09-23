/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewCommandPaletteLabel } from './reviewCommandPalette.js';

test('uses the human-readable command title', () => {
	assert.equal(
		reviewCommandPaletteLabel('review.installCliInPath', {
			title: { value: 'Review: Install CLI in PATH', original: 'Review: Install CLI in PATH' },
		}),
		'Review: Install CLI in PATH',
	);
});

test('includes a command category and removes icons', () => {
	assert.equal(
		reviewCommandPaletteLabel('extension.command', {
			title: '$(zap) Run',
			category: { value: 'Extension', original: 'Extension' },
		}),
		'Extension: Run',
	);
});

test('falls back to the command id when metadata is unavailable', () => {
	assert.equal(reviewCommandPaletteLabel('internal.command', undefined), 'internal.command');
});
