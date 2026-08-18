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
 * `reviewConfigurationDefaults.ts`. Renderer code reaches it through the bare
 * side-effect import in `review.common.main.ts`.
 *
 * The setting keys and default values live in `reviewConfigurationDefaults.ts`
 * and are deliberately *not* re-exported from here: a re-export would let a
 * main-process consumer import data through this module and put the registry
 * back on its import path.
 */
import { localize } from '../../nls.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { REVIEW_KEYMAPS, REVIEW_KEYMAP_SETTING, REVIEW_SOFTWARE_MAP_SETTING, REVIEW_TELEMETRY_SETTING, curatedExtensionConfigurationDefaults, reviewConfigurationDefaults } from './reviewConfigurationDefaults.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'review',
	title: localize('reviewConfigurationTitle', "Review"),
	type: 'object',
	scope: ConfigurationScope.APPLICATION,
	properties: {
		[REVIEW_KEYMAP_SETTING]: {
			type: 'string',
			enum: [...REVIEW_KEYMAPS],
			default: 'none',
			description: localize('review.keymap', "Select the curated keymap extension Review enables."),
		},
		[REVIEW_TELEMETRY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('review.telemetry.enabled', "Send anonymous Review usage data."),
		},
		[REVIEW_SOFTWARE_MAP_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('review.experimental.softwareMap.enabled', "Show the experimental Software Map view in reviews."),
		},
	},
});

configurationRegistry.registerDefaultConfigurations([
	{ overrides: reviewConfigurationDefaults },
	{ overrides: curatedExtensionConfigurationDefaults }
]);
