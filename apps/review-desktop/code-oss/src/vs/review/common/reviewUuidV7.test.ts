/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { uuidV7 } from './reviewUuidV7.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('encodes the millisecond timestamp in the first 48 bits', () => {
	const now = Date.parse('2026-09-23T12:00:00.000Z');
	const id = uuidV7(now, new Uint8Array(16));
	assert.equal(parseInt(id.replace(/-/g, '').slice(0, 12), 16), now);
	assert.equal(id, `${now.toString(16).padStart(12, '0').replace(/^(.{8})/, '$1-')}-7000-8000-000000000000`);
});

test('sets version 7 and variant 10xx whatever the random bytes are', () => {
	const id = uuidV7(Date.parse('2026-09-23T12:00:00.000Z'), new Uint8Array(16).fill(0xff));
	assert.match(id, UUID_V7);
	assert.equal(id.slice(-22), '7fff-bfff-ffffffffffff');
});

test('fresh ids are distinct, valid and time ordered', () => {
	const first = uuidV7(1_000);
	const second = uuidV7(2_000);
	assert.match(first, UUID_V7);
	assert.match(second, UUID_V7);
	assert.notEqual(uuidV7(), uuidV7());
	assert.ok(first < second);
});
