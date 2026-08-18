/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Review's update surface: two toasts, and a command to check on demand.
 *
 * Review deliberately omits the stock `workbench/contrib/update` — its title bar
 * entry depends on the chat service, which Review does not register. This is the
 * whole replacement: tell the reader when an update is waiting on a restart, and
 * confirm once it has landed.
 *
 * Squirrel installs a staged update whenever the app quits, with or without the
 * toast, so the prompt is an invitation to restart now, not a gate on updating.
 */

import { localize, localize2 } from '../../../nls.js';
import { toAction } from '../../../base/common/actions.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import Severity from '../../../base/common/severity.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INotificationService, type INotificationHandle } from '../../../platform/notification/common/notification.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import {
	darwinFailedUpdateNoticeId,
	DARWIN_FAILED_UPDATE_STORAGE_KEY,
	parseDarwinFailedUpdate,
	shouldAnnounceDarwinFailedUpdate,
} from '../../../platform/update/common/darwinUpdateRecovery.js';
import { IUpdateService, StateType, type State } from '../../../platform/update/common/update.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import {
	decideUpdateNotice,
	parseStagedUpdate,
	serializeStagedUpdate,
	shouldPromptForUpdate,
	stagedUpdateFromReady,
	supersedesStagedUpdate,
	type IReviewStagedUpdate,
} from '../../common/reviewUpdateNotice.js';

/** The update downloaded and waiting for a restart. */
const STAGED_UPDATE_STORAGE_KEY = 'review.update.staged.v1';
/** Target commit the reader asked not to be prompted about again. */
const SKIPPED_UPDATE_STORAGE_KEY = 'review.update.skipped.v1';
/** Failed update attempt that Review already announced. */
const FAILED_UPDATE_NOTICE_STORAGE_KEY = 'review.update.failedNotice.v1';

class ReviewUpdateNotifications extends Disposable {

	static readonly ID = 'review.update.notifications';

	/** The visible "ready to install" toast, kept so a re-fire cannot stack duplicates. */
	private readyHandle: INotificationHandle | undefined;
	/** Which commit `readyHandle` is about. */
	private readyCommit: string | undefined;

	constructor(
		@IUpdateService private readonly updateService: IUpdateService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.announceFailedUpdate();
		this.announceCompletedUpdate();
		this._register(this.storageService.onDidChangeValue(
			StorageScope.APPLICATION,
			DARWIN_FAILED_UPDATE_STORAGE_KEY,
			this._store,
		)(() => this.announceFailedUpdate()));

		this._register(this.updateService.onStateChange(state => {
			this.announceFailedUpdate();
			this.onStateChange(state);
		}));
		// The channel client replays its initial state, but reading it directly
		// keeps this correct regardless of when the contribution is created.
		this.onStateChange(this.updateService.state);
	}

	private announceFailedUpdate(): void {
		const failure = parseDarwinFailedUpdate(
			this.storageService.get(DARWIN_FAILED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION),
		);
		const announcedNoticeId = this.storageService.get(
			FAILED_UPDATE_NOTICE_STORAGE_KEY,
			StorageScope.APPLICATION,
		);
		if (!shouldAnnounceDarwinFailedUpdate(failure, this.productService.commit, announcedNoticeId)) {
			return;
		}

		this.storageService.store(
			FAILED_UPDATE_NOTICE_STORAGE_KEY,
			darwinFailedUpdateNoticeId(failure),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		this.logService.error(`[ReviewUpdate] update failed (${failure.targetCommit})`);
		this.notificationService.notify({
			severity: Severity.Error,
			message: localize('review.update.installFailed', "Update failed"),
		});
	}

	/**
	 * If this launch is the first one on a build we staged, say so — once.
	 *
	 * The record is cleared whether or not it matched: a record for some other
	 * build is stale (a hand-installed DMG, or an abandoned update) and should
	 * disappear silently rather than linger and fire later.
	 */
	private announceCompletedUpdate(): void {
		const staged = parseStagedUpdate(
			this.storageService.get(STAGED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION),
		);
		const notice = decideUpdateNotice(staged, this.productService.commit);
		if (notice.kind === 'none') {
			return;
		}

		this.storageService.remove(STAGED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION);
		if (notice.kind === 'clear') {
			return;
		}

		// The update landed, so any skip recorded against it is spent.
		this.storageService.remove(SKIPPED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION);
		this.logService.info(`[ReviewUpdate] running the staged update (${this.productService.commit})`);
		this.notificationService.notify({
			severity: Severity.Info,
			message: notice.productVersion
				? localize('review.update.applied', "Review updated to {0}.", notice.productVersion)
				: localize('review.update.applied.unknownVersion', "Review has been updated."),
		});
	}

	/**
	 * Only `Ready` matters.
	 *
	 * On macOS the flow is Idle → CheckingForUpdates → Downloading → Downloaded →
	 * Ready, and the last two are set back to back, so `Downloaded` is never a
	 * resting state. `AvailableForDownload` occurs only on a metered connection
	 * and resolves itself on the next check once off metered, so surfacing it
	 * would add a download-progress story for a state that clears on its own.
	 */
	private onStateChange(state: State): void {
		if (state.type !== StateType.Ready) {
			return;
		}

		const next = stagedUpdateFromReady(state.update);
		if (!next) {
			this.logService.warn('[ReviewUpdate] update is ready but carries no commit; nothing to record');
			return;
		}

		// Record before considering the prompt: the update installs on quit even
		// when skipped, so the post-restart toast must still be able to fire.
		const staged = parseStagedUpdate(
			this.storageService.get(STAGED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION),
		);
		if (supersedesStagedUpdate(staged, next)) {
			this.storageService.store(
				STAGED_UPDATE_STORAGE_KEY,
				serializeStagedUpdate(next),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
		}

		const skipped = this.storageService.get(SKIPPED_UPDATE_STORAGE_KEY, StorageScope.APPLICATION);
		if (!shouldPromptForUpdate(next, skipped)) {
			return;
		}
		if (this.readyHandle && this.readyCommit === next.targetCommit) {
			return;
		}

		this.showReadyNotification(next);
	}

	private showReadyNotification(next: IReviewStagedUpdate): void {
		// A newer update superseded whatever was on screen.
		this.readyHandle?.close();

		const handle = this.notificationService.notify({
			severity: Severity.Info,
			// Waits for a decision rather than expiring unseen.
			sticky: true,
			message: next.productVersion
				? localize('review.update.ready', "Review {0} is ready to install.", next.productVersion)
				: localize('review.update.ready.unknownVersion', "A Review update is ready to install."),
			actions: {
				primary: [
					toAction({
						id: 'review.update.restart',
						label: localize('review.update.restart', "Restart to Update"),
						run: () => {
							void this.updateService.quitAndInstall();
						},
					}),
					toAction({
						id: 'review.update.skip',
						label: localize('review.update.skip', "Skip This Version"),
						run: () => {
							this.storageService.store(
								SKIPPED_UPDATE_STORAGE_KEY,
								next.targetCommit,
								StorageScope.APPLICATION,
								StorageTarget.MACHINE,
							);
						},
					}),
				],
			},
		});

		this.readyHandle = handle;
		this.readyCommit = next.targetCommit;
		this._register(handle.onDidClose(() => {
			this.readyHandle = undefined;
			this.readyCommit = undefined;
		}));
	}
}

/**
 * Checking on demand. Without this the only trigger is the scheduled check, 30
 * seconds after startup and hourly after that. An explicit check also bypasses
 * the metered-connection path, so it always resolves to a downloaded update.
 */
class ReviewCheckForUpdatesAction extends Action2 {

	constructor() {
		super({
			id: 'review.checkForUpdates',
			title: localize2('review.checkForUpdates', "Check for Updates..."),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IUpdateService).checkForUpdates(true);
	}
}

registerAction2(ReviewCheckForUpdatesAction);
registerWorkbenchContribution2(
	ReviewUpdateNotifications.ID,
	ReviewUpdateNotifications,
	WorkbenchPhase.AfterRestored,
);
