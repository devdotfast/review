/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
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
import { whenFirstRunReloadDecided } from '../../common/reviewFirstRunReload.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';

export const NOTICE_STORAGE_KEY = 'review.telemetry.noticeShown.v1';

export class ReviewTelemetryNotice implements IWorkbenchContribution {
	constructor(
		@IStorageService storageService: IStorageService,
		@INotificationService notificationService: INotificationService,
		@IReviewCanvasEditorTabsService tabsService: IReviewCanvasEditorTabsService,
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
		void this.show(storageService, notificationService, tabsService);
	}

	private async show(
		storageService: IStorageService,
		notificationService: INotificationService,
		tabsService: IReviewCanvasEditorTabsService,
	): Promise<void> {
		if (await whenFirstRunReloadDecided()) {
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
				"Review sends anonymous usage data. You can change this in Settings.",
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
).registerWorkbenchContribution(ReviewTelemetryNotice, LifecyclePhase.Restored);
