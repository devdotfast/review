/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ColorScheme } from '../../platform/theme/common/theme.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';

/**
 * The theme choice, shared by the `review.selectTheme` quick pick and the
 * Settings canvas tab. This module registers nothing, so the canvas part can
 * import it without pulling in a contribution.
 */

const REVIEW_DARK_THEME = 'Review Dark';
const REVIEW_LIGHT_THEME = 'Review Light';

export type ReviewThemeChoice = 'dark' | 'light' | 'system';

export function currentReviewThemeChoice(configurationService: IConfigurationService, themeService: IThemeService): ReviewThemeChoice {
	if (configurationService.getValue<boolean>('window.autoDetectColorScheme')) {
		return 'system';
	}

	// The theme service applies a theme change asynchronously, so a read taken
	// right after applyReviewThemeChoice still reports the previous theme. The
	// configured name is authoritative whenever it names a Review theme.
	const configured = configurationService.getValue<string>('workbench.colorTheme');
	if (configured === REVIEW_LIGHT_THEME) {
		return 'light';
	}
	if (configured === REVIEW_DARK_THEME) {
		return 'dark';
	}

	const type = themeService.getColorTheme().type;
	return type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT ? 'light' : 'dark';
}

export async function applyReviewThemeChoice(configurationService: IConfigurationService, choice: ReviewThemeChoice): Promise<void> {
	switch (choice) {
		case 'dark':
			await configurationService.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.colorTheme', REVIEW_DARK_THEME, ConfigurationTarget.USER);
			break;
		case 'light':
			await configurationService.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.colorTheme', REVIEW_LIGHT_THEME, ConfigurationTarget.USER);
			break;
		case 'system':
			await configurationService.updateValue('window.autoDetectColorScheme', true, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.preferredDarkColorTheme', REVIEW_DARK_THEME, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.preferredLightColorTheme', REVIEW_LIGHT_THEME, ConfigurationTarget.USER);
			break;
	}
}
