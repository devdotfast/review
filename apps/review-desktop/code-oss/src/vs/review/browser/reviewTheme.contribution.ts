/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { type ReviewThemeChoice, applyReviewThemeChoice, currentReviewThemeChoice } from './reviewThemeChoice.js';

interface IReviewThemeQuickPickItem extends IQuickPickItem {
	readonly choice: ReviewThemeChoice;
}

class SelectReviewThemeAction extends Action2 {
	constructor() {
		super({
			id: 'review.selectTheme',
			title: localize2('review.selectTheme', "Review: Theme"),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const themeService = accessor.get(IThemeService);
		const currentChoice = currentReviewThemeChoice(configurationService, themeService);
		const items: IReviewThemeQuickPickItem[] = [
			{ choice: 'light', label: localize('review.theme.light', "Light"), picked: currentChoice === 'light' },
			{ choice: 'dark', label: localize('review.theme.dark', "Dark"), picked: currentChoice === 'dark' },
			{ choice: 'system', label: localize('review.theme.system', "System"), picked: currentChoice === 'system' }
		];

		const picked = await quickInputService.pick(items, {
			title: localize('review.theme.title', "Review: Theme"),
			placeHolder: localize('review.theme.placeholder', "Select a theme")
		});
		if (!picked) {
			return;
		}

		await applyReviewThemeChoice(configurationService, picked.choice);
	}
}

registerAction2(SelectReviewThemeAction);

MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	command: {
		id: 'review.selectTheme',
		title: localize('review.selectTheme.menu', "Theme...")
	},
	order: 0
});
