/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createReviewServerEnvironment } from './reviewServerSupervisor.js';

test('the trusted product version overrides inherited environment values', () => {
	const environment = createReviewServerEnvironment({
		applicationEnvironment: {
			DEV_FAST_REVIEW_APP_VERSION: '0.0.1',
			PATH: '/application/bin',
		},
		resolvedEnvironment: {
			DEV_FAST_REVIEW_APP_VERSION: '99.0.0',
			PATH: '/login/bin',
		},
		appVersion: '0.0.16',
		serverEntry: '/review/server.js',
		port: 4321,
		token: 'token',
		instanceId: 'instance',
		appPid: 1234,
		telemetryEnabled: true,
	});

	assert.equal(environment.PATH, '/login/bin');
	assert.equal(environment.DEV_FAST_REVIEW_APP_VERSION, '0.0.16');
	assert.equal(environment.DEV_FAST_REVIEW_SERVER_ENTRY, '/review/server.js');
	assert.equal(environment.DEV_FAST_REVIEW_SERVER_PORT, '4321');
	assert.equal(environment.DEV_FAST_REVIEW_TELEMETRY_DISABLED, undefined);
});
