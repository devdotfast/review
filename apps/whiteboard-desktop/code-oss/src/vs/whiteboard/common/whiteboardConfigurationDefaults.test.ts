/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { whiteboardConfigurationDefaults } from './whiteboardConfigurationDefaults.js';

test('turns off diff indicators for the indicator-free visual language', () => {
	assert.equal(whiteboardConfigurationDefaults['diffEditor.renderIndicators'], false);
});

test('keeps the VSCodium-derived opt-out defaults', () => {
	assert.equal(whiteboardConfigurationDefaults['telemetry.telemetryLevel'], 'off');
	assert.equal(whiteboardConfigurationDefaults['telemetry.enableTelemetry'], false);
	assert.equal(whiteboardConfigurationDefaults['telemetry.enableCrashReporter'], false);
	assert.equal(whiteboardConfigurationDefaults['telemetry.editStats.enabled'], false);
	assert.equal(whiteboardConfigurationDefaults['workbench.enableExperiments'], false);
	assert.equal(
		whiteboardConfigurationDefaults['workbench.commandPalette.experimental.enableNaturalLanguageSearch'],
		false,
	);
	assert.equal(whiteboardConfigurationDefaults['workbench.settings.enableNaturalLanguageSearch'], false);
});
