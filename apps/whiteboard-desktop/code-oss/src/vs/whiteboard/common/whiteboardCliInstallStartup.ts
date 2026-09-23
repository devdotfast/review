/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WhiteboardCliInstallStatus } from './whiteboardProtocol.js';

export type WhiteboardCliInstallStartupAction = 'none' | 'resync' | 'openWelcome';

/**
 * What a built app does with the install stamp at startup. Only a granted
 * stamp acts: an upgrader without the update marker sees the update screen,
 * and a stale fingerprint rewrites the whiteboard command silently.
 */
export function whiteboardCliInstallStartupAction(status: WhiteboardCliInstallStatus): WhiteboardCliInstallStartupAction {
	if (status.stamp?.consent !== 'granted') {
		return 'none';
	}
	if (status.updateNeeded) {
		return 'openWelcome';
	}
	return status.stale ? 'resync' : 'none';
}
