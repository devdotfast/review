/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { whiteboardCommandPaletteLabel } from './whiteboardCommandPalette.js';

test('uses the human-readable command title', () => {
	assert.equal(
		whiteboardCommandPaletteLabel('whiteboard.installCliInPath', {
			title: { value: 'Review: Install CLI in PATH', original: 'Review: Install CLI in PATH' },
		}),
		'Review: Install CLI in PATH',
	);
});

test('includes a command category and removes icons', () => {
	assert.equal(
		whiteboardCommandPaletteLabel('extension.command', {
			title: '$(zap) Run',
			category: { value: 'Extension', original: 'Extension' },
		}),
		'Extension: Run',
	);
});

test('falls back to the command id when metadata is unavailable', () => {
	assert.equal(whiteboardCommandPaletteLabel('internal.command', undefined), 'internal.command');
});
