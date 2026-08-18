/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decisions behind Review's update toasts, kept free of services so they can be
 * tested directly.
 *
 * Everything here keys off the build's `commit`, never its version. Packaged
 * `product.json` carries the Code OSS version (`1.129.1`) for every Review
 * release, so it is identical before and after an update and cannot say whether
 * one landed. Only `commit` changes. The release semver a human recognises
 * ("0.0.7") exists solely in the update feed's `productVersion`, which is why it
 * has to be captured from the update payload and stored rather than read back
 * off the running product.
 */

/** A downloaded update, staged and waiting for the restart that applies it. */
export interface IReviewStagedUpdate {
	/** `product.json` `commit` of the build that will be running after restart. */
	readonly targetCommit: string;
	/** Release semver, e.g. "0.0.7". Absent if the feed omitted it. */
	readonly productVersion?: string;
}

export function serializeStagedUpdate(staged: IReviewStagedUpdate): string {
	return JSON.stringify(staged);
}

/**
 * Storage is user-writable and survives across versions, so treat anything
 * unexpected as absent rather than throwing — this runs during workbench
 * startup, where a parse error would be a far worse outcome than a missed toast.
 */
export function parseStagedUpdate(raw: string | undefined): IReviewStagedUpdate | undefined {
	if (!raw) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const { targetCommit, productVersion } = parsed as Record<string, unknown>;
	if (typeof targetCommit !== 'string' || !targetCommit) {
		return undefined;
	}
	return {
		targetCommit,
		productVersion: typeof productVersion === 'string' && productVersion ? productVersion : undefined,
	};
}

/**
 * `IUpdate.version` is the target commit and `IUpdate.productVersion` the
 * release semver — the update Worker documents that split, and the darwin
 * service validates both fields separately.
 */
export function stagedUpdateFromReady(update: { version?: string; productVersion?: string } | undefined): IReviewStagedUpdate | undefined {
	if (!update?.version) {
		return undefined;
	}
	return { targetCommit: update.version, productVersion: update.productVersion };
}

export type ReviewUpdateNotice =
	/** Nothing was staged; say nothing. */
	| { readonly kind: 'none' }
	/** Something was staged but it is not what is running; drop it silently. */
	| { readonly kind: 'clear' }
	/** The staged update is now running; announce it once. */
	| { readonly kind: 'announce'; readonly productVersion?: string };

/**
 * Whether this launch is the first one after a staged update applied.
 *
 * A missing `currentCommit` means an unbuilt run, where updates are disabled
 * outright — clear rather than announce, so a record left by a packaged build
 * cannot produce a bogus toast in a development window.
 */
export function decideUpdateNotice(
	staged: IReviewStagedUpdate | undefined,
	currentCommit: string | undefined,
): ReviewUpdateNotice {
	if (!staged) {
		return { kind: 'none' };
	}
	if (currentCommit && currentCommit === staged.targetCommit) {
		return { kind: 'announce', productVersion: staged.productVersion };
	}
	return { kind: 'clear' };
}

/** Whether a newly-ready update replaces whatever was staged before it. */
export function supersedesStagedUpdate(
	existing: IReviewStagedUpdate | undefined,
	next: IReviewStagedUpdate,
): boolean {
	return !existing || existing.targetCommit !== next.targetCommit;
}

/**
 * Whether to prompt for this update.
 *
 * Skipping is bound to the exact commit, so a later release still prompts. Note
 * that skipping only silences the toast: Squirrel still installs the update on
 * quit, which is why the staged record is written regardless.
 */
export function shouldPromptForUpdate(
	next: IReviewStagedUpdate,
	skippedCommit: string | undefined,
): boolean {
	return !skippedCommit || skippedCommit !== next.targetCommit;
}
