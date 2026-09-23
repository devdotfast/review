/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Records a crash that happens before Review can start.
 *
 * `src/main.ts` runs before the message table, the service collection, and the
 * embedded server exist. A failure there leaves no log and no window: Review
 * Desktop 0.0.4 shipped exactly that and could not launch. So this module does
 * the least it can — one line of JSON in a file — and the next launch reports
 * it through the normal, opted-in path.
 *
 * Constraints that keep it safe to import from `src/main.ts`:
 *  - Node built-ins only. No `localize`, no registry, no other module. The
 *    bootstrap import test walks this file and fails on any of those.
 *  - Synchronous, because the process is about to die.
 *  - Never throws. A failure to record a crash must not become the crash.
 *
 * Writing a local file is not telemetry, so no consent check applies here. The
 * consent check happens when the next launch tries to send the line.
 */

const BREADCRUMB_FILE = 'review-bootstrap-errors.jsonl';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_STACK_LENGTH = 8 * 1024;

export interface ReviewBootstrapBreadcrumb {
	readonly t: number;
	readonly name: string;
	readonly message: string;
	readonly stack: string;
}

export function reviewBootstrapBreadcrumbPath(userDataPath: string): string {
	return path.join(userDataPath, BREADCRUMB_FILE);
}

/** Append one crash note. Silent on every failure. */
export function writeReviewBootstrapBreadcrumb(userDataPath: string, error: unknown, now: number = Date.now()): void {
	try {
		const file = reviewBootstrapBreadcrumbPath(userDataPath);
		let size = 0;
		try {
			size = statSync(file).size;
		} catch {
			size = 0; // no file yet
		}
		if (size >= MAX_FILE_BYTES) {
			return; // a crash loop must not fill the disk
		}
		const candidate = error as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
		const breadcrumb: ReviewBootstrapBreadcrumb = {
			t: now,
			name: typeof candidate?.name === 'string' ? candidate.name : 'Error',
			message: typeof candidate?.message === 'string' ? candidate.message : String(error),
			stack: typeof candidate?.stack === 'string' ? candidate.stack.slice(0, MAX_STACK_LENGTH) : '',
		};
		mkdirSync(userDataPath, { recursive: true });
		appendFileSync(file, `${JSON.stringify(breadcrumb)}\n`, 'utf8');
	} catch {
		// Recording a crash must never raise one.
	}
}

/**
 * Read every recorded crash and delete the file. The file goes whether or not
 * the caller reports the entries, so an opted-out user never accumulates one.
 */
export function drainReviewBootstrapBreadcrumbs(userDataPath: string): ReviewBootstrapBreadcrumb[] {
	const file = reviewBootstrapBreadcrumbPath(userDataPath);
	let contents: string;
	try {
		contents = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	try {
		rmSync(file, { force: true });
	} catch {
		// A file we cannot delete is capped by MAX_FILE_BYTES anyway.
	}
	const breadcrumbs: ReviewBootstrapBreadcrumb[] = [];
	for (const line of contents.split('\n')) {
		if (!line) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as ReviewBootstrapBreadcrumb;
			if (parsed && typeof parsed.stack === 'string') {
				breadcrumbs.push(parsed);
			}
		} catch {
			// One unreadable line must not lose the others.
		}
	}
	return breadcrumbs;
}
