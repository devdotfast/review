/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import Severity from '../../../base/common/severity.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import {
	Extensions as WorkbenchExtensions,
	type IWorkbenchContribution,
	type IWorkbenchContributionsRegistry,
} from '../../../workbench/common/contributions.js';
import { LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { isFirstRunReloadPending } from '../../common/whiteboardFirstRunReload.js';
import { IWhiteboardCanvasEditorTabsService } from '../../services/whiteboardCanvasEditorTabsService.js';

export const NOTICE_STORAGE_KEY = 'review.telemetry.noticeShown.v1';

export class WhiteboardTelemetryNotice implements IWorkbenchContribution {
	constructor(
		@IStorageService storageService: IStorageService,
		@INotificationService notificationService: INotificationService,
		@IWhiteboardCanvasEditorTabsService tabsService: IWhiteboardCanvasEditorTabsService,
	) {
		if (
			storageService.getBoolean(
				NOTICE_STORAGE_KEY,
				StorageScope.APPLICATION,
				false,
			)
		) {
			return;
		}
		this.show(storageService, notificationService, tabsService).catch(onUnexpectedError);
	}

	private async show(
		storageService: IStorageService,
		notificationService: INotificationService,
		tabsService: IWhiteboardCanvasEditorTabsService,
	): Promise<void> {
		if (await isFirstRunReloadPending()) {
			return; // the seeding reload would take the notice with it
		}
		// Spend the notice only once the reader answers it: a reload before then removes
		// the notice, and a flag written up front never brings it back.
		const markShown = () => storageService.store(
			NOTICE_STORAGE_KEY,
			true,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		notificationService.prompt(
			Severity.Info,
			localize(
				'review.telemetry.notice',
				"Whiteboard sends anonymous usage data. You can change this in Settings.",
			),
			[{
				label: localize(
					'review.telemetry.openSettings',
					"Open Settings",
				),
				// Review does not register the stock settings editor, so the
				// Settings canvas tab is where this setting lives.
				run: () => {
					markShown();
					void tabsService.openSettings(true);
				},
			}],
			{ sticky: true, onCancel: markShown },
		);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench,
).registerWorkbenchContribution(WhiteboardTelemetryNotice, LifecyclePhase.Restored);
