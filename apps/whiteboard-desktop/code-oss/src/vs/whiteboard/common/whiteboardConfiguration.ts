/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Registers Review's configuration with the workbench.
 *
 * Importing this module pulls in the configuration registry, which constructs
 * itself — and localizes — at module scope. That makes it unsafe anywhere the
 * Electron main process can reach before `bootstrapESM()`; see the header of
 * `whiteboardConfigurationDefaults.ts`. Renderer code reaches it through the bare
 * side-effect import in `whiteboard.common.main.ts`.
 *
 * The setting keys and default values live in `whiteboardConfigurationDefaults.ts`
 * and are deliberately *not* re-exported from here: a re-export would let a
 * main-process consumer import data through this module and put the registry
 * back on its import path.
 */
import { localize } from '../../nls.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { WHITEBOARD_KEYMAPS, WHITEBOARD_KEYMAP_SETTING, WHITEBOARD_SOFTWARE_MAP_SETTING, WHITEBOARD_STRUCTURAL_DIFF_SETTING, WHITEBOARD_TELEMETRY_SETTING, curatedExtensionConfigurationDefaults, whiteboardConfigurationDefaults } from './whiteboardConfigurationDefaults.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'whiteboard',
	title: localize('whiteboardConfigurationTitle', "Whiteboard"),
	type: 'object',
	scope: ConfigurationScope.APPLICATION,
	properties: {
		[WHITEBOARD_KEYMAP_SETTING]: {
			type: 'string',
			enum: [...WHITEBOARD_KEYMAPS],
			default: 'none',
			description: localize('whiteboard.keymap', "Select the curated keymap extension Whiteboard enables."),
		},
		[WHITEBOARD_TELEMETRY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('whiteboard.telemetry.enabled', "Send anonymous Whiteboard usage data."),
		},
		[WHITEBOARD_STRUCTURAL_DIFF_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('whiteboard.experimental.structuralDiff.enabled', "Replace the standard diff view with structural diffs from diffr."),
		},
		[WHITEBOARD_SOFTWARE_MAP_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('whiteboard.experimental.softwareMap.enabled', "Show the experimental Software Map view in sessions."),
		},
	},
});

configurationRegistry.registerDefaultConfigurations([
	{ overrides: whiteboardConfigurationDefaults },
	{ overrides: curatedExtensionConfigurationDefaults }
]);
