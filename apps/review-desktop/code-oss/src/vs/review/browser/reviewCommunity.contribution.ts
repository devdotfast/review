/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { REVIEW_DISCORD_URL } from '../common/reviewProtocol.js';

const DISMISSED_KEY = 'review.community.dontShowAgain';

class ReviewCommunityContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devfast.reviewCommunity';

	constructor(
		@IDialogService dialogService: IDialogService,
		@IStorageService storageService: IStorageService,
		@IOpenerService openerService: IOpenerService,
	) {
		if (storageService.getBoolean(DISMISSED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		void dialogService.confirm({
			type: 'info',
			message: 'Join the Review community',
			detail: 'Meet the team, ask questions, and share feedback in the /dev/fast Discord. You can also join anytime using the Discord link next to Report a bug.',
			primaryButton: 'Join Discord',
			cancelButton: 'Not now',
			checkbox: { label: "Don't show again" },
		}).then(async result => {
			if (result.checkboxChecked) {
				storageService.store(DISMISSED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			if (result.confirmed) {
				await openerService.open(REVIEW_DISCORD_URL, { openExternal: true });
			}
		}).catch(onUnexpectedError);
	}
}

registerWorkbenchContribution2(ReviewCommunityContribution.ID, ReviewCommunityContribution, WorkbenchPhase.AfterRestored);
