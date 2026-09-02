/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewCliInstallStatus, ReviewCliInstallTarget } from './reviewProtocol.js';

export interface ReviewCliInstallResyncRequest {
	readonly targets: readonly ReviewCliInstallTarget[];
	readonly shim: boolean;
}

export function reviewCliInstallResyncRequest(status: ReviewCliInstallStatus): ReviewCliInstallResyncRequest | undefined {
	const targets = status.stamp?.targets !== undefined
		? status.stamp.targets
		: status.agents.filter(agent => agent.installed).map(agent => agent.target);
	const shim = Boolean(status.stamp?.shimPath);
	return targets.length > 0 || shim ? { targets, shim } : undefined;
}
