/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { Emitter } from '../../base/common/event.js';
import { type INotification, type INotificationActions, NoOpNotification, type NotificationMessage, Severity } from '../../platform/notification/common/notification.js';
import type { ChoiceAction } from '../../workbench/common/notifications.js';
import { StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { ReviewListError } from '../common/reviewProtocol.js';
import { REVIEW_MIGRATION_DISMISSED_VERSION_KEY, REVIEW_MIGRATION_PROMPT, ReviewMigrationNotification } from './reviewMigrationNotification.js';

class TestStorage {
	readonly changes = new Emitter<void>();
	readonly values = new Map<string, string>();
	writes = 0;
	get(key: string): string | undefined { return this.values.get(key); }
	store(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
		assert.equal(scope, StorageScope.APPLICATION);
		assert.equal(target, StorageTarget.MACHINE);
		this.values.set(key, value);
		this.writes++;
		this.changes.fire();
	}
	onDidChangeValue() { return this.changes.event; }
}

class TestNotification extends NoOpNotification {
	readonly closed = new Emitter<void>();
	override readonly onDidClose = this.closed.event;
	isClosed = false;
	actions: INotificationActions | undefined;
	override updateActions(actions: INotificationActions): void { this.actions = actions; }
	constructor(public message: NotificationMessage) { super(); }
	override updateMessage(message: NotificationMessage): void { this.message = message; }
	override close(): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.closed.fire();
	}
}

function fixture(version = '0.0.31', storage = new TestStorage()) {
	const lists = new Emitter<void>();
	const session = { reviewErrors: [] as ReviewListError[], onDidChangeLists: lists.event };
	const prompts: { notification: TestNotification; choices: ChoiceAction[]; options?: INotification }[] = [];
	const errors: NotificationMessage[] = [];
	const clipboard = { text: '', async writeText(text: string) { this.text = text; } };
	const contribution = new ReviewMigrationNotification(
		session as never,
		{
			notify(options: INotification) {
				const { severity, message, actions } = options;
				const choices = actions!.primary as ChoiceAction[];
				assert.equal(severity, Severity.Warning);
				const notification = new TestNotification(message);
				prompts.push({ notification, choices, options });
				return notification;
			},
			error(message: NotificationMessage) { errors.push(message); },
		} as never,
		clipboard as never,
		storage as never,
		{ reviewVersion: version, version: '1.129.1' } as never,
	);
	return {
		contribution, prompts, clipboard, storage, errors,
		setErrors(count: number) {
			session.reviewErrors = Array.from({ length: count }, (_, index) => ({
				reviewDir: `/tmp/review-${index}`, reviewUuid: null, title: 'Legacy Review', worktreePath: '/tmp',
				lastPublishedAt: null, code: 'MIGRATION_REQUIRED', message: 'Migration required',
			}));
			lists.fire();
		},
		dispose() { contribution.dispose(); lists.dispose(); },
	};
}

test('updates one native notification and closes it after migration without dismissing', t => {
	const f = fixture(); t.after(() => f.dispose());
	assert.equal(f.prompts.length, 0);
	f.setErrors(1);
	const first = f.prompts[0];
	assert.equal(first.notification.message, '1 Review needs migration.');
	assert.equal(first.options?.sticky, true);
	assert.equal(first.choices[1].label, 'Copy prompt');
	assert.equal(first.choices[1].keepOpen, true);
	f.setErrors(20);
	assert.equal(f.prompts.length, 1);
	assert.equal(first.notification.message, '20 Reviews need migration.');
	f.setErrors(0);
	assert.equal(first.notification.isClosed, true);
	assert.equal(f.storage.writes, 0);
	f.setErrors(1);
	assert.equal(f.prompts.length, 2);
});

test('copying confirms then dismisses across windows and restarts until an update', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const storage = new TestStorage();
	const f = fixture('0.0.31', storage); t.after(() => f.dispose());
	const other = fixture('0.0.31', storage); t.after(() => other.dispose());
	f.setErrors(20); other.setErrors(20);
	f.prompts[0].choices[1].run();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.clipboard.text, REVIEW_MIGRATION_PROMPT);
	assert.equal(f.prompts[0].notification.actions?.primary?.[1].label, '✓ Copied');
	assert.equal(f.prompts[0].notification.message, '20 Reviews need migration.');
	assert.equal(f.prompts[0].notification.isClosed, false);
	t.mock.timers.tick(499);
	assert.equal(f.prompts[0].notification.isClosed, false);
	t.mock.timers.tick(1);
	assert.equal(f.prompts[0].notification.isClosed, true);
	assert.equal(storage.get(REVIEW_MIGRATION_DISMISSED_VERSION_KEY), '0.0.31');
	assert.equal(other.prompts[0].notification.isClosed, true);
	assert.equal(storage.writes, 1);
	f.setErrors(21);
	assert.equal(f.prompts.length, 1);
	const restarted = fixture('0.0.31', storage); t.after(() => restarted.dispose());
	restarted.setErrors(20);
	assert.equal(restarted.prompts.length, 0);
	const updated = fixture('0.0.32', storage); t.after(() => updated.dispose());
	updated.setErrors(20);
	assert.equal(updated.prompts.length, 1);
});

test('shutdown closes the notification without persisting dismissal', () => {
	const f = fixture();
	f.setErrors(20);
	f.dispose();
	assert.equal(f.prompts[0].notification.isClosed, true);
	assert.equal(f.storage.writes, 0);
	f.setErrors(20);
	assert.equal(f.prompts.length, 1);
});

test('a clipboard failure keeps the migration action available', async t => {
	const f = fixture(); t.after(() => f.dispose());
	f.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
	f.setErrors(1);
	f.prompts[0].choices[1].run();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.prompts[0].notification.isClosed, false);
	assert.equal(f.prompts[0].notification.message, '1 Review needs migration.');
	assert.equal(f.errors.length, 1);
	assert.equal(f.storage.writes, 0);
});

test('preserves dismissal from the former canvas toast', t => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
		getItem(key: string) { assert.equal(key, REVIEW_MIGRATION_DISMISSED_VERSION_KEY); return '0.0.31'; },
	} });
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
		else Reflect.deleteProperty(globalThis, 'localStorage');
	});
	const f = fixture(); t.after(() => f.dispose());
	f.setErrors(20);
	assert.equal(f.prompts.length, 0);
	assert.equal(f.storage.get(REVIEW_MIGRATION_DISMISSED_VERSION_KEY), '0.0.31');
});


test('the visible Dismiss action saves dismissal for the current app version', t => {
	const f = fixture(); t.after(() => f.dispose());
	f.setErrors(20);
	assert.equal(f.prompts[0].choices[0].label, 'Dismiss');
	f.prompts[0].choices[0].run();
	assert.equal(f.prompts[0].notification.isClosed, true);
	assert.equal(f.storage.get(REVIEW_MIGRATION_DISMISSED_VERSION_KEY), '0.0.31');
	f.setErrors(21);
	assert.equal(f.prompts.length, 1);
});
