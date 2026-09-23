/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { isFirstRunReloadPending } from '../common/whiteboardFirstRunReload.js';
import { WHITEBOARD_DISCORD_URL } from '../common/whiteboardProtocol.js';
import { IWhiteboardApiCatalogService } from '../services/reviewApiCatalogService.js';

export const DISMISSED_KEY = 'review.community.dontShowAgain';

export class WhiteboardCommunityContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devfast.whiteboardCommunity';

	constructor(
		@IDialogService dialogService: IDialogService,
		@IStorageService storageService: IStorageService,
		@IOpenerService openerService: IOpenerService,
		@IWhiteboardApiCatalogService catalogService: IWhiteboardApiCatalogService,
	) {
		if (storageService.getBoolean(DISMISSED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		this.invite(dialogService, storageService, openerService, catalogService).catch(onUnexpectedError);
	}

	private async invite(dialogService: IDialogService, storageService: IStorageService, openerService: IOpenerService, catalogService: IWhiteboardApiCatalogService): Promise<void> {
		if (await isFirstRunReloadPending()) {
			return; // the seeding reload would discard both the question and the answer
		}
		await catalogService.initialize();
		if (catalogService.whiteboards.filter(whiteboard => whiteboard.kind !== 'scratchpad').length < 2) {
			return;
		}
		const result = await dialogService.confirm({
			type: 'info',
			message: 'Join the Whiteboard community',
			detail: 'Meet the team, ask questions, and share feedback in the /dev/fast Discord. You can also join anytime using the Discord link next to Report a bug.',
			primaryButton: 'Join Discord',
			cancelButton: 'Not now',
		});
		storageService.store(DISMISSED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (result.confirmed) {
			await openerService.open(WHITEBOARD_DISCORD_URL, { openExternal: true });
		}
	}
}

registerWorkbenchContribution2(WhiteboardCommunityContribution.ID, WhiteboardCommunityContribution, WorkbenchPhase.AfterRestored);
