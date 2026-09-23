/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewCliInstallStatus } from './reviewProtocol.js';

export type ReviewCliInstallStartupAction = 'none' | 'resync' | 'openWelcome';

/**
 * What a built app does with the install stamp at startup. Only a granted
 * stamp acts: an upgrader without the update marker sees the update screen,
 * and a stale fingerprint rewrites the review command silently.
 */
export function reviewCliInstallStartupAction(status: ReviewCliInstallStatus): ReviewCliInstallStartupAction {
	if (status.stamp?.consent !== 'granted') {
		return 'none';
	}
	if (status.updateNeeded) {
		return 'openWelcome';
	}
	return status.stale ? 'resync' : 'none';
}
