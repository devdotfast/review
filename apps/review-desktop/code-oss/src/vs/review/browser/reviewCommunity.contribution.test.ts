/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IConfirmation, IConfirmationResult } from '../../platform/dialogs/common/dialogs.js';
import { REVIEW_DISCORD_URL } from '../common/reviewProtocol.js';
import { setFirstRunReloadPending } from '../common/reviewFirstRunReload.js';
import { DISMISSED_KEY, ReviewCommunityContribution } from './reviewCommunity.contribution.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(answer: Promise<IConfirmationResult>, reviews: Array<{ kind?: "scratchpad" }> = [{}, {}], dismissed = false) {
	const catalog = { reviews, initialize: async () => { } };
	const asked: IConfirmation[] = [];
	const stored: Array<{ key: string; value: unknown }> = [];
	const opened: unknown[] = [];
	const captured: Array<[string, unknown]> = [];
	const invite = () => new ReviewCommunityContribution(
		{ confirm: (confirmation: IConfirmation) => { asked.push(confirmation); return answer; } } as never,
		{ getBoolean: () => dismissed, store: (key: string, value: unknown) => { stored.push({ key, value }); dismissed = Boolean(value); } } as never,
		{ open: async (target: unknown) => { opened.push(target); return true; } } as never,
		catalog as never,
		{ capture: (name: string, properties?: unknown) => { captured.push([name, properties]); } } as never,
	);
	return { asked, stored, opened, invite, catalog, captured };
}

test('skips the invitation when the first-run seeding reload is pending', async () => {
	setFirstRunReloadPending(true);
	const { asked, stored, invite } = setup(new Promise<IConfirmationResult>(() => { }));
	invite();
	await settle();
	assert.deepEqual(asked, [], 'the reload would discard the invitation');
	assert.deepEqual(stored, []);
});

for (const confirmed of [false, true]) {
	test(`permanently dismisses the invitation after ${confirmed ? 'joining' : 'declining'}`, async () => {
		setFirstRunReloadPending(false);
		const { asked, stored, opened, invite, captured } = setup(Promise.resolve({ confirmed }));
		invite();
		await settle();
		assert.equal(asked.length, 1);
		assert.deepEqual(stored, [{ key: DISMISSED_KEY, value: true }]);
		assert.deepEqual(opened, confirmed ? [REVIEW_DISCORD_URL] : []);
		assert.deepEqual(captured, confirmed
			? [['discord_dialog_shown', undefined], ['discord_clicked', { via: 'dialog' }]]
			: [['discord_dialog_shown', undefined], ['discord_dialog_dismissed', undefined]]);
		invite();
		await settle();
		assert.equal(asked.length, 1, 'subsequent launches must not ask again');
	});
}

for (const reviews of [[], [{}], [{}, { kind: "scratchpad" as const }]]) {
	test(`skips the invitation with fewer than two reviews: ${JSON.stringify(reviews)}`, async () => {
		setFirstRunReloadPending(false);
		const { asked, invite } = setup(Promise.resolve({ confirmed: false }), reviews);
		invite();
		await settle();
		assert.equal(asked.length, 0);
	});
}

test('waits until the next launch after the second review is created', async () => {
	setFirstRunReloadPending(false);
	const { asked, invite, catalog } = setup(Promise.resolve({ confirmed: false }), [{}]);
	invite();
	await settle();
	catalog.reviews.push({});
	await settle();
	assert.equal(asked.length, 0);
	invite();
	await settle();
	assert.equal(asked.length, 1);
});

test('waits for the catalog to load before checking eligibility', async () => {
	setFirstRunReloadPending(false);
	const { asked, invite, catalog } = setup(Promise.resolve({ confirmed: false }), []);
	let loaded!: () => void;
	catalog.initialize = () => new Promise<void>(resolve => { loaded = resolve; });
	invite();
	await settle();
	assert.equal(asked.length, 0);
	catalog.reviews.push({}, {}, {});
	loaded();
	await settle();
	assert.equal(asked.length, 1);
});

test('respects permanent dismissal after two reviews', async () => {
	setFirstRunReloadPending(false);
	const { asked, invite } = setup(Promise.resolve({ confirmed: false }), [{}, {}], true);
	invite();
	await settle();
	assert.equal(asked.length, 0);
});
