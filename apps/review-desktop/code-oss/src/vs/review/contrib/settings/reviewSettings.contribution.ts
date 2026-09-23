/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../nls.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';

/**
 * Opens the Settings canvas tab. Review does not register the stock settings
 * editor, so this tab is the only settings surface in the app.
 */
class OpenReviewSettingsAction extends Action2 {
	constructor() {
		super({
			id: 'review.openSettings',
			title: localize2('review.openSettings', "Review: Settings..."),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Comma,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IReviewCanvasEditorTabsService).openSettings(true);
	}
}

registerAction2(OpenReviewSettingsAction);
