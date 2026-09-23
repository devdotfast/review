/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	REVIEW_DESKTOP_CONNECTION_VERSION,
	ReviewReadyEventReader,
} from './reviewDesktopBootstrap.js';

const credentials = {
	token: 'token',
	instanceId: 'instance',
};

test('carries the install id from the ready message', () => {
	const reader = new ReviewReadyEventReader(credentials);
	const connection = reader.push(`${JSON.stringify({
		event: 'ready',
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: 'http://127.0.0.1:4321',
		...credentials,
		installationId: 'install-123',
	})}\n`);

	assert.equal(connection?.installationId, 'install-123');
});

test('accepts an older ready message without an install id', () => {
	const reader = new ReviewReadyEventReader(credentials);
	const connection = reader.push(`${JSON.stringify({
		event: 'ready',
		version: REVIEW_DESKTOP_CONNECTION_VERSION,
		url: 'http://127.0.0.1:4321',
		...credentials,
	})}\n`);

	assert.equal(connection?.installationId, undefined);
});
