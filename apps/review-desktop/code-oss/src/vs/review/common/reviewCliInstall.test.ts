/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewCliInstallStatus } from './reviewProtocol.js';
import { reviewCliInstallResyncRequest } from './reviewCliInstall.js';

const baseStatus: ReviewCliInstallStatus = {
	agents: [],
	fingerprint: 'current',
	stamp: null,
	stale: true,
	shim: {
		path: '/home/test/.local/bin/review',
		installed: false,
		profileConfigured: false,
		onPath: false,
	},
	fff: {
		serverName: 'fff',
		corpusRoot: '/home/test/.dev/trace-search',
		binary: { path: '/home/test/.local/bin/fff-mcp', installed: false },
		registrations: [],
	},
	trace: {
		enabled: false,
		configured: false,
		autoActivateRepositories: false,
		envPath: '/home/test/.dev/trace.env',
		settingsPath: '/home/test/.dev/trace-settings.json',
	},
	cli: null,
};

test('resyncs a CLI-only installation', () => {
	assert.deepEqual(
		reviewCliInstallResyncRequest({
			...baseStatus,
			agents: [{ target: 'codex', present: true, installed: true }],
			stamp: {
				consent: 'granted',
				targets: [],
				shimPath: '/home/test/.local/bin/review',
				updatedAt: '2026-09-02T00:00:00.000Z',
			},
		}),
		{ targets: [], shim: true },
	);
});

test('falls back to installed skills for a legacy stamp without targets', () => {
	assert.deepEqual(
		reviewCliInstallResyncRequest({
			...baseStatus,
			agents: [{ target: 'codex', present: true, installed: true }],
			stamp: {
				consent: 'granted',
				updatedAt: '2026-09-02T00:00:00.000Z',
			},
		}),
		{ targets: ['codex'], shim: false },
	);
});

test('preserves an explicit CLI opt-out while resyncing skills', () => {
	assert.deepEqual(
		reviewCliInstallResyncRequest({
			...baseStatus,
			stamp: {
				consent: 'granted',
				targets: ['codex'],
				updatedAt: '2026-09-02T00:00:00.000Z',
			},
		}),
		{ targets: ['codex'], shim: false },
	);
});

test('skips resync when neither skills nor the CLI are managed', () => {
	assert.equal(reviewCliInstallResyncRequest(baseStatus), undefined);
});
