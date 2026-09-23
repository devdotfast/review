/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, type IWorkbenchContributionsRegistry } from '../../workbench/common/contributions.js';

/**
 * Seeding the keymap defaults reloads the window once on a fresh profile
 * (reviewCuratedExtensions.contribution.ts). A startup prompt must skip itself
 * when that reload is coming: the reload takes both the question and the
 * answer with it, and a storage write after the shutdown close is dropped.
 */

let pending: boolean | undefined;

export function setFirstRunReloadPending(reloadPending: boolean): void {
	pending = reloadPending;
}

/** Resolves once the seeder has decided; a seeder that never ran means no reload. */
export async function isFirstRunReloadPending(): Promise<boolean> {
	if (pending === undefined) {
		await Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).whenRestored;
	}
	return pending ?? false;
}
