/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { CancellationError, ErrorNoTelemetry } from "../../base/common/errors.js";
import {
	packReviewError,
	ReviewErrorReportLimiter,
	type ReviewErrorReport,
} from "./reviewErrorReport.js";

function errorWithStack(message: string): Error {
	const error = new TypeError(message);
	error.stack = `TypeError: ${message}\n    at f (/app/out/vs/review/browser/workbench.js:1:1)`;
	return error;
}

test("packReviewError keeps the name, message, and stack", () => {
	const packed = packReviewError(errorWithStack("boom"));
	assert.equal(packed?.name, "TypeError");
	assert.equal(packed?.message, "boom");
	assert.match(packed?.stack ?? "", /workbench\.js:1:1/);
});

test("packReviewError skips errors that say nothing about a defect", () => {
	assert.equal(packReviewError(undefined), undefined);
	assert.equal(packReviewError("boom"), undefined);
	assert.equal(packReviewError({ name: "Error", message: "no stack" }), undefined);
	const systemError = errorWithStack("EACCES") as Error & { code?: string };
	systemError.code = "EACCES";
	assert.equal(packReviewError(systemError), undefined);
	const noTelemetry = new ErrorNoTelemetry("private");
	noTelemetry.stack = "CodeExpectedError\n    at f (/app/out/vs/base/common/errors.js:1:1)";
	assert.equal(packReviewError(noTelemetry), undefined);
	const cancelled = new CancellationError();
	cancelled.stack = "Canceled\n    at f (/app/out/vs/base/common/errors.js:1:1)";
	assert.equal(packReviewError(cancelled), undefined);
});

test("packReviewError unwraps a loader error and an array stack", () => {
	const packed = packReviewError({
		detail: { name: "SyntaxError", message: "bad", stack: ["SyntaxError: bad", "    at f (/app/out/vs/code/x.js:2:2)"] },
	});
	assert.equal(packed?.name, "SyntaxError");
	assert.match(packed?.stack ?? "", /vs\/code\/x\.js:2:2/);
});

test("the limiter removes an immediate repeat but allows it later", () => {
	let now = 1000;
	const limiter = new ReviewErrorReportLimiter(30, () => now);
	const sent: ReviewErrorReport[] = [];
	const send = (report: ReviewErrorReport): void => { sent.push(report); };

	limiter.report(errorWithStack("boom"), send);
	limiter.report(errorWithStack("boom"), send);
	assert.equal(sent.length, 1);

	now += 1001;
	limiter.report(errorWithStack("boom"), send);
	assert.equal(sent.length, 2);
});

test("the limiter caps a session and never lets a report raise an error", () => {
	let now = 0;
	const limiter = new ReviewErrorReportLimiter(3, () => (now += 5000));
	let sent = 0;
	for (let index = 0; index < 10; index++) {
		limiter.report(errorWithStack(`boom ${index}`), () => { sent++; });
	}
	assert.equal(sent, 3);

	const guarded = new ReviewErrorReportLimiter(30, () => 0);
	assert.doesNotThrow(() => {
		guarded.report(errorWithStack("boom"), () => { throw new Error("reporting failed"); });
	});
});

test("the limiter refuses to run inside itself", () => {
	const limiter = new ReviewErrorReportLimiter(30, () => 0);
	let depth = 0;
	limiter.report(errorWithStack("outer"), () => {
		depth++;
		limiter.report(errorWithStack("inner"), () => { depth++; });
	});
	assert.equal(depth, 1);
});
