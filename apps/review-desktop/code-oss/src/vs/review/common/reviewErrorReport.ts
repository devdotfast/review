/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError, ErrorNoTelemetry } from "../../base/common/errors.js";

/**
 * Shared error reporting rules for the Review workbench and the Review part of
 * the Electron main process.
 *
 * The raw name, message, and stack packed here travel only to the loopback
 * Review server on the same machine. That server replaces the message with a
 * digest and keeps only the stack frames that resolve inside the shipped
 * bundle; see packages/progressive-review/src/error-telemetry.ts. Nothing in
 * this file is ever sent to a vendor as it stands.
 *
 * The filters mirror upstream `BaseErrorTelemetry._onErrorEvent`. They are
 * reimplemented rather than imported because that module pulls the whole file
 * service in behind it, and this one runs in the main process too.
 */

export interface ReviewErrorReport {
	readonly name: string;
	readonly message: string;
	readonly stack: string;
}

/**
 * Unwrap a loader error, then decide whether it is worth reporting. Errors with
 * a system `code`, cancellations, errors marked as never-report, and errors
 * without a stack are all skipped: none of them says anything about a defect in
 * Review.
 */
export function packReviewError(error: unknown): ReviewErrorReport | undefined {
	if (!error || typeof error !== 'object') {
		return undefined;
	}
	let candidate = error as { code?: unknown; detail?: { stack?: unknown }; name?: unknown; message?: unknown; stack?: unknown };
	if (candidate.code) {
		return undefined;
	}
	// Unwrap nested errors from the module loader, as upstream does.
	if (candidate.detail && (candidate.detail as { stack?: unknown }).stack) {
		candidate = candidate.detail as typeof candidate;
	}
	if (ErrorNoTelemetry.isErrorNoTelemetry(candidate as Error) || candidate instanceof CancellationError) {
		return undefined;
	}
	// Array stacks come from workerServer.ts; upstream works around this too.
	const stack = Array.isArray(candidate.stack) ? candidate.stack.join('\n') : candidate.stack;
	if (typeof stack !== 'string' || stack.length === 0) {
		return undefined; // an error without a stack is not useful telemetry
	}
	return {
		name: typeof candidate.name === 'string' ? candidate.name : 'Error',
		message: typeof candidate.message === 'string' ? candidate.message : '',
		stack,
	};
}

/**
 * Keeps error reporting from becoming its own incident: it removes bursts of
 * one repeating error, bounds the total per session, and refuses to run inside
 * itself when reporting an error throws another one.
 */
export class ReviewErrorReportLimiter {
	private static readonly REPEAT_WINDOW_MS = 1000;

	private previousKey: string | undefined;
	private previousTime = 0;
	private reported = 0;
	private reporting = false;

	constructor(
		private readonly maxPerSession = 30,
		private readonly now: () => number = () => Date.now(),
	) { }

	/**
	 * Pack the error, decide whether it is worth reporting, and hand it to
	 * `send`. Re-entry is blocked, so an error raised inside `send` cannot start
	 * a second report, and nothing here ever throws: the callers sit on the
	 * error path itself, where a throw would escape into unrelated code.
	 */
	report(error: unknown, send: (report: ReviewErrorReport) => void): void {
		if (this.reporting) {
			return;
		}
		this.reporting = true;
		try {
			if (this.reported >= this.maxPerSession) {
				return;
			}
			const packed = packReviewError(error);
			if (!packed || this.isRepeat(packed)) {
				return;
			}
			this.reported++;
			send(packed);
		} catch {
			// Reporting an error must never raise one.
		} finally {
			this.reporting = false;
		}
	}

	private isRepeat(report: ReviewErrorReport): boolean {
		const key = `${report.name}\n${report.stack.split('\n', 2).join('\n')}`;
		const time = this.now();
		const repeat = key === this.previousKey && time - this.previousTime <= ReviewErrorReportLimiter.REPEAT_WINDOW_MS;
		this.previousKey = key;
		this.previousTime = time;
		return repeat;
	}
}
