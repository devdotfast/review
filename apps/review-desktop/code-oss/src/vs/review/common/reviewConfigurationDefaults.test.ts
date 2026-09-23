/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { REVIEW_KEYMAP_SETTING, reviewConfigurationDefaults } from './reviewConfigurationDefaults.js';

test('turns off diff indicators for the indicator-free visual language', () => {
	assert.equal(reviewConfigurationDefaults['diffEditor.renderIndicators'], false);
});

test('titles the window Review and enables the native navigation control', () => {
	assert.equal(reviewConfigurationDefaults['window.title'], 'Review');
	assert.equal(reviewConfigurationDefaults['workbench.navigationControl.enabled'], true);
});

test('names the curated keymap setting review.keymap', () => {
	assert.equal(REVIEW_KEYMAP_SETTING, 'review.keymap');
});

test('keeps the VSCodium-derived opt-out defaults', () => {
	assert.equal(reviewConfigurationDefaults['telemetry.telemetryLevel'], 'off');
	assert.equal(reviewConfigurationDefaults['telemetry.enableTelemetry'], false);
	assert.equal(reviewConfigurationDefaults['telemetry.enableCrashReporter'], false);
	assert.equal(reviewConfigurationDefaults['telemetry.editStats.enabled'], false);
	assert.equal(reviewConfigurationDefaults['workbench.enableExperiments'], false);
	assert.equal(
		reviewConfigurationDefaults['workbench.commandPalette.experimental.enableNaturalLanguageSearch'],
		false,
	);
	assert.equal(reviewConfigurationDefaults['workbench.settings.enableNaturalLanguageSearch'], false);
});
