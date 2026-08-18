/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// This test lives under common/ because that is one of the three directories
// the Review unit-test glob covers; the module under test is in node/.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	drainReviewBootstrapBreadcrumbs,
	reviewBootstrapBreadcrumbPath,
	writeReviewBootstrapBreadcrumb,
} from "../node/reviewBootstrapBreadcrumb.js";

function withTempUserData(body: (userDataPath: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "review-breadcrumb-"));
	try {
		body(path.join(root, "user-data"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a crash note round-trips and the file is then gone", () => {
	withTempUserData(userDataPath => {
		const error = new TypeError("cannot load main");
		error.stack = "TypeError: cannot load main\n    at f (/app/out/vs/code/electron-main/main.js:1:1)";
		writeReviewBootstrapBreadcrumb(userDataPath, error, 1234);

		const drained = drainReviewBootstrapBreadcrumbs(userDataPath);
		assert.equal(drained.length, 1);
		assert.equal(drained[0].name, "TypeError");
		assert.equal(drained[0].message, "cannot load main");
		assert.equal(drained[0].t, 1234);
		assert.match(drained[0].stack, /electron-main\/main\.js:1:1/);
		assert.equal(existsSync(reviewBootstrapBreadcrumbPath(userDataPath)), false);
		assert.deepEqual(drainReviewBootstrapBreadcrumbs(userDataPath), []);
	});
});

test("several crashes accumulate as separate lines", () => {
	withTempUserData(userDataPath => {
		writeReviewBootstrapBreadcrumb(userDataPath, new Error("first"));
		writeReviewBootstrapBreadcrumb(userDataPath, new Error("second"));
		assert.deepEqual(
			drainReviewBootstrapBreadcrumbs(userDataPath).map(entry => entry.message),
			["first", "second"],
		);
	});
});

test("a crash loop cannot fill the disk", () => {
	withTempUserData(userDataPath => {
		writeReviewBootstrapBreadcrumb(userDataPath, new Error("first"));
		const file = reviewBootstrapBreadcrumbPath(userDataPath);
		writeFileSync(file, `${"x".repeat(70 * 1024)}\n`, "utf8");
		writeReviewBootstrapBreadcrumb(userDataPath, new Error("dropped"));
		assert.equal(readFileSync(file, "utf8").includes("dropped"), false);
	});
});

test("recording a crash never raises one", () => {
	assert.doesNotThrow(() => {
		writeReviewBootstrapBreadcrumb("", undefined);
		writeReviewBootstrapBreadcrumb("\0invalid", new Error("boom"));
	});
	assert.deepEqual(drainReviewBootstrapBreadcrumbs("\0invalid"), []);
});

test("one unreadable line does not lose the others", () => {
	withTempUserData(userDataPath => {
		writeReviewBootstrapBreadcrumb(userDataPath, new Error("kept"));
		const file = reviewBootstrapBreadcrumbPath(userDataPath);
		writeFileSync(file, `not json\n${readFileSync(file, "utf8")}`, "utf8");
		assert.deepEqual(
			drainReviewBootstrapBreadcrumbs(userDataPath).map(entry => entry.message),
			["kept"],
		);
	});
});
