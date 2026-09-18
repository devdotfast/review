/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IConfirmation, IConfirmationResult } from '../../platform/dialogs/common/dialogs.js';
import { signalFirstRunReload } from '../common/reviewFirstRunReload.js';
import { DISMISSED_KEY, ReviewCommunityContribution } from './reviewCommunity.contribution.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(answer: Promise<IConfirmationResult>) {
	const asked: IConfirmation[] = [];
	const stored: Array<{ key: string; value: unknown }> = [];
	const opened: unknown[] = [];
	const invite = () => new ReviewCommunityContribution(
		{ confirm: (confirmation: IConfirmation) => { asked.push(confirmation); return answer; } } as never,
		{ getBoolean: () => false, store: (key: string, value: unknown) => stored.push({ key, value }) } as never,
		{ open: async (target: unknown) => { opened.push(target); return true; } } as never,
	);
	return { asked, stored, opened, invite };
}

test('does not invite while the first-run seeding reload is pending', async () => {
	signalFirstRunReload(true);
	const { asked, stored, invite } = setup(new Promise<IConfirmationResult>(() => { }));
	invite();
	await settle();
	assert.deepEqual(asked, [], 'the invitation waits for the reload');
	assert.deepEqual(stored, []);
});

test('records "Don\'t show again" once the seeding reload is settled', async () => {
	signalFirstRunReload(false);
	const { asked, stored, opened, invite } = setup(Promise.resolve({ confirmed: false, checkboxChecked: true }));
	invite();
	await settle();
	assert.equal(asked.length, 1);
	assert.deepEqual(stored, [{ key: DISMISSED_KEY, value: true }]);
	assert.deepEqual(opened, []);
});
