/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Seeding the keymap defaults reloads the window once on a fresh profile
 * (reviewCuratedExtensions.contribution.ts). Anything that asks the reader a
 * question during startup has to wait for that decision: a reload takes both
 * the question and the answer with it, and a storage write that lands after
 * the shutdown close is dropped silently.
 */

let decided: boolean | undefined;
const waiting: Array<(reloadPending: boolean) => void> = [];

export function signalFirstRunReload(reloadPending: boolean): void {
	decided = reloadPending;
	while (waiting.length) {
		waiting.pop()?.(reloadPending);
	}
}

export function whenFirstRunReloadDecided(): Promise<boolean> {
	return decided === undefined
		? new Promise<boolean>(resolve => { waiting.push(resolve); })
		: Promise.resolve(decided);
}
