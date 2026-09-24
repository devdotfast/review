/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewCliInstallStatus } from './reviewProtocol.js';

export type ReviewCliInstallStartupAction = 'none' | 'resync' | 'openWelcome';

/** Legacy skills or an unfinished upgrade open Welcome before any silent CLI resync. */
export function reviewCliInstallStartupAction(status: ReviewCliInstallStatus): ReviewCliInstallStartupAction {
	if (status.updateNeeded) {
		return 'openWelcome';
	}
	return status.stamp?.consent === 'granted' && status.stale ? 'resync' : 'none';
}
