/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewCliInstallStatus } from './reviewProtocol.js';
import { reviewCliInstallStartupAction } from './reviewCliInstallStartup.js';

const base: ReviewCliInstallStatus = {
	fingerprint: 'f',
	stamp: null,
	stale: false,
	updateNeeded: false,
	shim: { path: '/p', installed: true, profileConfigured: true, onPath: true },
	trace: { enabled: false, configured: false, autoActivateRepositories: false, envPath: '/e', settingsPath: '/s' },
	cli: null,
	connect: { command: 'review', args: ['mcp'], prompts: { claude: '', codex: '', cursor: '', opencode: '', pi: '' }, plugins: { claude: { label: 'c' }, codex: { label: 'c' }, cursor: { label: 'c' }, opencode: { label: 'c' }, pi: { label: 'c' } } },
	legacySkills: [],
};

test('opens Welcome for an upgrader before resyncing', () => {
	assert.equal(
		reviewCliInstallStartupAction({ ...base, stamp: { consent: 'granted', updatedAt: 't' }, updateNeeded: true, stale: true }),
		'openWelcome',
	);
});

test('resyncs a stale stamp', () => {
	assert.equal(
		reviewCliInstallStartupAction({ ...base, stamp: { consent: 'granted', updatedAt: 't' }, stale: true }),
		'resync',
	);
});

test('does nothing when declined', () => {
	assert.equal(
		reviewCliInstallStartupAction({ ...base, stamp: { consent: 'declined', updatedAt: 't' }, stale: true }),
		'none',
	);
});

for (const consent of [null, 'declined', 'skipped'] as const) {
	test(`opens the skill upgrade without granted consent (${consent})`, () => {
		assert.equal(reviewCliInstallStartupAction({
			...base,
			stamp: consent ? { consent, updatedAt: 't' } : null,
			updateNeeded: true,
			legacySkills: [{ path: '~/.agents/skills/dev-review' }],
		}), 'openWelcome');
	});
}
