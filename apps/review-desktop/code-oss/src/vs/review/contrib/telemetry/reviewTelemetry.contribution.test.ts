/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IPromptChoice, IPromptOptions } from '../../../platform/notification/common/notification.js';
import { signalFirstRunReload } from '../../common/reviewFirstRunReload.js';
import { NOTICE_STORAGE_KEY, ReviewTelemetryNotice } from './reviewTelemetry.contribution.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup() {
	const stored: Array<{ key: string; value: unknown }> = [];
	const prompts: Array<{ choices: IPromptChoice[]; options?: IPromptOptions }> = [];
	const notice = () => new ReviewTelemetryNotice(
		{ getBoolean: () => false, store: (key: string, value: unknown) => stored.push({ key, value }) } as never,
		{
			prompt: (_severity: unknown, _message: string, choices: IPromptChoice[], options?: IPromptOptions) => {
				prompts.push({ choices, options });
				return { close() { } };
			},
		} as never,
		{ openSettings: async () => { } } as never,
	);
	return { stored, prompts, notice };
}

test('keeps the telemetry notice unspent until the reader answers it', async () => {
	signalFirstRunReload(false);
	const { stored, prompts, notice } = setup();
	notice();
	await settle();
	assert.equal(prompts.length, 1, 'the notice is shown');
	assert.deepEqual(stored, [], 'showing the notice does not record it as seen');
	prompts[0].options?.onCancel?.();
	assert.deepEqual(stored, [{ key: NOTICE_STORAGE_KEY, value: true }]);
});

test('waits for the first-run seeding reload before showing the notice', async () => {
	signalFirstRunReload(true);
	const { stored, prompts, notice } = setup();
	notice();
	await settle();
	assert.deepEqual(prompts, [], 'a pending reload would take the notice with it');
	assert.deepEqual(stored, []);
});
