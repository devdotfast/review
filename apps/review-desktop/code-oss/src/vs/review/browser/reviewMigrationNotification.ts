/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { ChoiceAction } from '../../workbench/common/notifications.js';
import { Event } from '../../base/common/event.js';
import { Disposable, type IDisposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { type INotificationHandle, INotificationService, Severity } from '../../platform/notification/common/notification.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IReviewSessionService } from '../services/reviewSessionService.js';

export const REVIEW_MIGRATION_PROMPT =
	'Use the local `review` CLI to migrate my Review data. Run `review migrate apply`. If a code comment position cannot be recovered, rerun `review migrate apply --force` to drop only the unrecoverable threads. Then restart Review and confirm that the Reviews and comments load.';

export const REVIEW_MIGRATION_DISMISSED_VERSION_KEY = 'dev.fast.review.migrationDismissedVersion.v1';

/** One reminder per workbench window, independent of the active canvas. */
export class ReviewMigrationNotification extends Disposable {
	private readonly appVersion: string;
	private dismissedVersion: string | undefined;
	private notification: INotificationHandle | undefined;
	private readonly notificationListener = this._register(new MutableDisposable<IDisposable>());

	private readonly dismissAction = this._register(new ChoiceAction('review.migration.dismiss', { label: 'Dismiss', run: () => this.notification?.close() }));
	private readonly copyAction = this._register(new ChoiceAction('review.migration.copy', { label: 'Copy prompt', keepOpen: true, run: () => void this.copyPrompt() }));
	private readonly dismissAfterCopy = this._register(new RunOnceScheduler(() => this.notification?.close(), 1000));

	private updateCopyLabel(label: string): void {
		this.copyAction.label = label;
		this.notification?.updateActions({ primary: [this.dismissAction, this.copyAction] });
	}

	constructor(
		@IReviewSessionService private readonly sessionService: IReviewSessionService,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService productService: IProductService,
	) {
		super();
		this.appVersion = productService.reviewVersion ?? productService.version;
		this.dismissedVersion = storageService.get(REVIEW_MIGRATION_DISMISSED_VERSION_KEY, StorageScope.APPLICATION);
		// Preserve dismissals made by the previous canvas toast when upgrading.
		if (this.dismissedVersion === undefined) {
			try {
				this.dismissedVersion = globalThis.localStorage?.getItem(REVIEW_MIGRATION_DISMISSED_VERSION_KEY) ?? undefined;
			} catch {
				// DOM storage can be disabled; native storage remains available.
			}
			if (this.dismissedVersion !== undefined) {
				storageService.store(REVIEW_MIGRATION_DISMISSED_VERSION_KEY, this.dismissedVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		}
		this._register(sessionService.onDidChangeLists(() => this.update()));
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, REVIEW_MIGRATION_DISMISSED_VERSION_KEY, this._store)(() => {
			this.dismissedVersion = storageService.get(REVIEW_MIGRATION_DISMISSED_VERSION_KEY, StorageScope.APPLICATION);
			this.update();
		}));
		this.update();
	}

	private message(): string | undefined {
		const count = this.sessionService.reviewErrors.filter(error => error.code === 'MIGRATION_REQUIRED').length;
		return count === 0 ? undefined : `${count} ${count === 1 ? 'Review needs' : 'Reviews need'} migration.`;
	}

	private update(): void {
		const message = this.message();
		if (!message || this.dismissedVersion === this.appVersion) {
			this.closeNotification();
			return;
		}
		if (this.notification) {
			this.notification.updateMessage(message);
			return;
		}
		const notification = this.notificationService.notify({
			severity: Severity.Warning, message, sticky: true,
			actions: { primary: [this.dismissAction, this.copyAction] },
		});
		this.notification = notification;
		// Every user close, including successful copy, dismisses this app version.
		this.notificationListener.value = Event.once(notification.onDidClose)(() => {
			this.notification = undefined;
			this.dismissedVersion = this.appVersion;
			this.storageService.store(REVIEW_MIGRATION_DISMISSED_VERSION_KEY, this.appVersion, StorageScope.APPLICATION, StorageTarget.MACHINE);
		});
	}

	private async copyPrompt(): Promise<void> {
		const notification = this.notification;
		try {
			await this.clipboardService.writeText(REVIEW_MIGRATION_PROMPT);
			const message = this.message();
			if (notification && this.notification === notification && message) {
				this.updateCopyLabel('✓ Copied');
				this.dismissAfterCopy.schedule();
			}
		} catch (error) {
			this.notificationService.error(`Could not copy the migration prompt: ${String(error)}`);
		}
	}

	private closeNotification(): void {
		this.dismissAfterCopy.cancel();
		this.copyAction.label = 'Copy prompt';
		this.notificationListener.clear();
		this.notification?.close();
		this.notification = undefined;
	}

	override dispose(): void {
		// Shutdown or successful migration must not count as user dismissal.
		this.closeNotification();
		super.dispose();
	}
}
