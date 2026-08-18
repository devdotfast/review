/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	blocksAutomaticDarwinUpdate,
	darwinFailedUpdateNoticeId,
	parseDarwinFailedUpdate,
	resolveDarwinUpdateAttempt,
	shouldAnnounceDarwinFailedUpdate,
} from '../../platform/update/common/darwinUpdateRecovery.js';

const attempt = {
	sourceCommit: 'source',
	targetCommit: 'target',
	productVersion: '1.2.3',
	attemptedAt: 100,
};

test('records an update that did not replace its source build', () => {
	assert.deepEqual(
		resolveDarwinUpdateAttempt(JSON.stringify(attempt), 'source', 200),
		{ kind: 'failed', failure: { ...attempt, failedAt: 200 } },
	);
});

test('recognizes an applied or superseded update', () => {
	assert.deepEqual(
		resolveDarwinUpdateAttempt(JSON.stringify(attempt), 'target'),
		{ kind: 'applied', attempt },
	);
	assert.deepEqual(
		resolveDarwinUpdateAttempt(JSON.stringify(attempt), 'newer'),
		{ kind: 'superseded', attempt },
	);
});

test('blocks only the same failed target from automatic retry', () => {
	const failure = parseDarwinFailedUpdate(JSON.stringify({ ...attempt, failedAt: 200 }));
	assert.equal(blocksAutomaticDarwinUpdate(failure, 'target'), true);
	assert.equal(blocksAutomaticDarwinUpdate(failure, 'newer'), false);
});

test('announces each failed attempt once', () => {
	const failure = parseDarwinFailedUpdate(JSON.stringify({ ...attempt, failedAt: 200 }));
	assert.ok(failure);
	assert.equal(shouldAnnounceDarwinFailedUpdate(failure, 'source', undefined), true);

	const noticeId = darwinFailedUpdateNoticeId(failure);
	assert.equal(shouldAnnounceDarwinFailedUpdate(failure, 'source', noticeId), false);
	assert.equal(
		shouldAnnounceDarwinFailedUpdate({ ...failure, attemptedAt: 300, failedAt: 400 }, 'source', noticeId),
		true,
	);
	assert.equal(shouldAnnounceDarwinFailedUpdate(failure, 'target', undefined), false);
});

test('ignores invalid stored update data', () => {
	assert.deepEqual(resolveDarwinUpdateAttempt('{', 'source'), { kind: 'none' });
	assert.deepEqual(
		resolveDarwinUpdateAttempt(JSON.stringify({ ...attempt, attemptedAt: 'now' }), 'source'),
		{ kind: 'none' },
	);
	assert.equal(parseDarwinFailedUpdate(JSON.stringify({ ...attempt, failedAt: 'now' })), undefined);
});
