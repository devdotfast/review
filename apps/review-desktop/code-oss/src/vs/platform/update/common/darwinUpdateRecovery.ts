/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const DARWIN_UPDATE_ATTEMPT_STORAGE_KEY = 'update/darwin/attempt.v1';
export const DARWIN_FAILED_UPDATE_STORAGE_KEY = 'update/darwin/failed.v1';

export interface IDarwinUpdateAttempt {
	readonly sourceCommit: string;
	readonly targetCommit: string;
	readonly productVersion?: string;
	readonly attemptedAt: number;
}

export interface IDarwinFailedUpdate extends IDarwinUpdateAttempt {
	readonly failedAt: number;
}

export function parseDarwinUpdateAttempt(raw: string | undefined): IDarwinUpdateAttempt | undefined {
	const parsed = parseObject(raw);
	if (!parsed) {
		return undefined;
	}

	const { sourceCommit, targetCommit, productVersion, attemptedAt } = parsed;
	if (
		typeof sourceCommit !== 'string' || !sourceCommit ||
		typeof targetCommit !== 'string' || !targetCommit ||
		typeof attemptedAt !== 'number' || !Number.isFinite(attemptedAt)
	) {
		return undefined;
	}

	return {
		sourceCommit,
		targetCommit,
		productVersion: typeof productVersion === 'string' && productVersion ? productVersion : undefined,
		attemptedAt,
	};
}

export function parseDarwinFailedUpdate(raw: string | undefined): IDarwinFailedUpdate | undefined {
	const attempt = parseDarwinUpdateAttempt(raw);
	const parsed = parseObject(raw);
	if (!attempt || !parsed || typeof parsed.failedAt !== 'number' || !Number.isFinite(parsed.failedAt)) {
		return undefined;
	}

	return { ...attempt, failedAt: parsed.failedAt };
}

export type DarwinUpdateOutcome =
	| { readonly kind: 'none' }
	| { readonly kind: 'applied'; readonly attempt: IDarwinUpdateAttempt }
	| { readonly kind: 'failed'; readonly failure: IDarwinFailedUpdate }
	| { readonly kind: 'superseded'; readonly attempt: IDarwinUpdateAttempt };

export function resolveDarwinUpdateAttempt(
	raw: string | undefined,
	currentCommit: string | undefined,
	failedAt = Date.now(),
): DarwinUpdateOutcome {
	const attempt = parseDarwinUpdateAttempt(raw);
	if (!attempt || !currentCommit) {
		return { kind: 'none' };
	}
	if (currentCommit === attempt.targetCommit) {
		return { kind: 'applied', attempt };
	}
	if (currentCommit === attempt.sourceCommit) {
		return { kind: 'failed', failure: { ...attempt, failedAt } };
	}
	return { kind: 'superseded', attempt };
}

export function blocksAutomaticDarwinUpdate(failure: IDarwinFailedUpdate | undefined, targetCommit: string): boolean {
	return failure?.targetCommit === targetCommit;
}

export function darwinFailedUpdateNoticeId(failure: IDarwinFailedUpdate): string {
	return JSON.stringify([failure.targetCommit, failure.attemptedAt]);
}

export function shouldAnnounceDarwinFailedUpdate(
	failure: IDarwinFailedUpdate | undefined,
	currentCommit: string | undefined,
	announcedNoticeId: string | undefined,
): failure is IDarwinFailedUpdate {
	return !!failure &&
		failure.sourceCommit === currentCommit &&
		darwinFailedUpdateNoticeId(failure) !== announcedNoticeId;
}

function parseObject(raw: string | undefined): Record<string, unknown> | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}
