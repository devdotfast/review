/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { appendReviewInstallId } from './reviewAboutDialog.js';

test('appends the install id to visible and copied About details', () => {
	const about = appendReviewInstallId({
		title: 'Review',
		details: 'Version: 1',
		detailsToCopy: 'Version: 1',
	}, 'install-123');

	assert.equal(about.details, 'Version: 1\ninstall id: install-123');
	assert.equal(about.detailsToCopy, 'Version: 1\ninstall id: install-123');
});

test('keeps About useful when the install id is unavailable', () => {
	const about = appendReviewInstallId({
		title: 'Review',
		details: 'Version: 1',
		detailsToCopy: 'Version: 1',
	}, undefined);

	assert.equal(about.details, 'Version: 1\ninstall id: Unknown');
	assert.equal(about.detailsToCopy, 'Version: 1\ninstall id: Unknown');
});
