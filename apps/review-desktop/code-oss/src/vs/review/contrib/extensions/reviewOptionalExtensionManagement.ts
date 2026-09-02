/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { reviewOptionalExtensionCatalog } from '../../node/reviewOptionalExtensionCatalog.js';
import * as semver from '../../../base/common/semver/semver.js';

export type OptionalExtensionInstallPhase = 'download' | 'install';
export type OptionalExtensionInstallTrigger = 'user' | 'auto_upgrade';

export class OptionalExtensionInstallError extends Error {
	constructor(
		readonly phase: OptionalExtensionInstallPhase,
		readonly extensionId: string,
		readonly originalError: unknown,
		readonly rollbackErrors: readonly unknown[] = []
	) {
		super(`Optional extension ${phase} failed`);
	}
}

export interface OptionalExtensionInstallTransaction<T> {
	readonly groups: readonly string[];
	readonly installedIds: ReadonlySet<string>;
	readonly download: (extensionId: string) => Promise<string>;
	readonly install: (extensionId: string, vsixPath: string) => Promise<T>;
	readonly rollback: (installed: T) => Promise<void>;
	readonly onInstalled?: (extensionId: string, trigger: OptionalExtensionInstallTrigger, durationMs: number) => void;
	readonly onInstallFailed?: (extensionId: string, trigger: OptionalExtensionInstallTrigger, phase: OptionalExtensionInstallPhase) => void;
	readonly onRolledBack?: (extensionId: string) => void;
}

export async function installMissingOptionalExtensions<T>(
	transaction: OptionalExtensionInstallTransaction<T>,
	trigger: OptionalExtensionInstallTrigger = 'user'
): Promise<readonly T[]> {
	const requestedGroups = new Set(transaction.groups);
	const missing = reviewOptionalExtensionCatalog.filter(extension =>
		requestedGroups.has(extension.group) && !transaction.installedIds.has(extension.id)
	);
	if (missing.length === 0) {
		return [];
	}

	const downloads = new Map<string, string>();
	const startedAt = new Map<string, number>();
	await Promise.all(missing.map(async extension => {
		startedAt.set(extension.id, Date.now());
		try {
			downloads.set(extension.id, await transaction.download(extension.id));
		} catch (error) {
			transaction.onInstallFailed?.(extension.id, trigger, 'download');
			throw new OptionalExtensionInstallError('download', extension.id, error);
		}
	}));

	const installed: { readonly extensionId: string; readonly local: T }[] = [];
	const installOrder = [...missing].sort((left, right) => {
		if (left.role === right.role) {
			return 0;
		}
		return left.role === 'support' ? -1 : 1;
	});
	try {
		for (const extension of installOrder) {
			const vsixPath = downloads.get(extension.id);
			if (!vsixPath) {
				throw new Error(`Missing verified VSIX path for ${extension.id}`);
			}
			try {
				const local = await transaction.install(extension.id, vsixPath);
				installed.push({ extensionId: extension.id, local });
				transaction.onInstalled?.(extension.id, trigger, Date.now() - (startedAt.get(extension.id) ?? Date.now()));
			} catch (error) {
				transaction.onInstallFailed?.(extension.id, trigger, 'install');
				throw new OptionalExtensionInstallError('install', extension.id, error);
			}
		}
		return installed.map(entry => entry.local);
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		for (const entry of installed.reverse()) {
			try {
				await transaction.rollback(entry.local);
				transaction.onRolledBack?.(entry.extensionId);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (error instanceof OptionalExtensionInstallError) {
			throw new OptionalExtensionInstallError(error.phase, error.extensionId, error.originalError, rollbackErrors);
		}
		throw error;
	}
}

export function optionalGroupMemberIds(group: string): readonly string[] {
	return reviewOptionalExtensionCatalog
		.filter(extension => extension.group === group)
		.map(extension => extension.id);
}

export interface InstalledOptionalExtensionPin {
	readonly id: string;
	readonly version: string;
}

export interface OptionalExtensionPinUpgradeTransaction {
	readonly installed: readonly InstalledOptionalExtensionPin[];
	readonly download: (extensionId: string) => Promise<string>;
	readonly install: (extensionId: string, vsixPath: string) => Promise<void>;
	readonly stageRustAnalyzer: () => Promise<void>;
	readonly logError: (message: string, error: unknown) => void;
	readonly onInstalled?: (extensionId: string, trigger: OptionalExtensionInstallTrigger, durationMs: number) => void;
	readonly onInstallFailed?: (extensionId: string, trigger: OptionalExtensionInstallTrigger, phase: OptionalExtensionInstallPhase) => void;
}

export async function upgradeOptionalExtensionPins(
	transaction: OptionalExtensionPinUpgradeTransaction,
	trigger: OptionalExtensionInstallTrigger = 'auto_upgrade'
): Promise<readonly string[]> {
	const installed = new Map(transaction.installed.map(extension => [extension.id.toLowerCase(), extension.version]));
	const changed: string[] = [];
	for (const group of new Set(reviewOptionalExtensionCatalog.map(extension => extension.group))) {
		const primary = reviewOptionalExtensionCatalog.find(extension => extension.group === group && extension.role === 'primary');
		if (!primary || !installed.has(primary.id)) {
			continue;
		}

		const members = reviewOptionalExtensionCatalog
			.filter(extension => extension.group === group)
			.sort((left, right) => left.role === right.role ? 0 : left.role === 'support' ? -1 : 1);
		for (const extension of members) {
			const currentVersion = installed.get(extension.id);
			if (currentVersion && !semver.lt(currentVersion, extension.version)) {
				continue;
			}
			const startedAt = Date.now();
			let vsixPath: string;
			try {
				vsixPath = await transaction.download(extension.id);
			} catch (error) {
				transaction.onInstallFailed?.(extension.id, trigger, 'download');
				transaction.logError(`Could not update optional extension ${extension.id}`, error);
				break;
			}
			try {
				await transaction.install(extension.id, vsixPath);
				installed.set(extension.id, extension.version);
				changed.push(extension.id);
				transaction.onInstalled?.(extension.id, trigger, Date.now() - startedAt);
				if (extension.id === 'rust-lang.rust-analyzer') {
					await transaction.stageRustAnalyzer();
				}
			} catch (error) {
				transaction.onInstallFailed?.(extension.id, trigger, 'install');
				transaction.logError(`Could not update optional extension ${extension.id}`, error);
				break;
			}
		}
	}
	return changed;
}
