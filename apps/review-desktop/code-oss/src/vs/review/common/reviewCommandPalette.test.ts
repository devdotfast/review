/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { isReviewPaletteCommand, reviewCommandPaletteLabel } from './reviewCommandPalette.js';

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

test('keeps Whiteboard commands even when they name a left-out feature', () => {
	assert.equal(isReviewPaletteCommand('review.checkForUpdates', new Set()), true);
});

test('drops stock commands for features Whiteboard leaves out', () => {
	assert.equal(isReviewPaletteCommand('workbench.action.terminal.new', new Set()), false);
	assert.equal(isReviewPaletteCommand('workbench.action.openSettings', new Set()), false);
});

test('keeps extension-contributed commands for left-out features', () => {
	assert.equal(isReviewPaletteCommand('rust-analyzer.debug', new Set(['rust-analyzer.debug'])), true);
});

test('keeps other stock commands', () => {
	assert.equal(isReviewPaletteCommand('workbench.action.reloadWindow', new Set()), true);
});
