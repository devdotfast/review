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
	drainWhiteboardBootstrapBreadcrumbs,
	whiteboardBootstrapBreadcrumbPath,
	writeWhiteboardBootstrapBreadcrumb,
} from "../node/whiteboardBootstrapBreadcrumb.js";

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
		writeWhiteboardBootstrapBreadcrumb(userDataPath, error, 1234);

		const drained = drainWhiteboardBootstrapBreadcrumbs(userDataPath);
		assert.equal(drained.length, 1);
		assert.equal(drained[0].name, "TypeError");
		assert.equal(drained[0].message, "cannot load main");
		assert.equal(drained[0].t, 1234);
		assert.match(drained[0].stack, /electron-main\/main\.js:1:1/);
		assert.equal(existsSync(whiteboardBootstrapBreadcrumbPath(userDataPath)), false);
		assert.deepEqual(drainWhiteboardBootstrapBreadcrumbs(userDataPath), []);
	});
});

test("several crashes accumulate as separate lines", () => {
	withTempUserData(userDataPath => {
		writeWhiteboardBootstrapBreadcrumb(userDataPath, new Error("first"));
		writeWhiteboardBootstrapBreadcrumb(userDataPath, new Error("second"));
		assert.deepEqual(
			drainWhiteboardBootstrapBreadcrumbs(userDataPath).map(entry => entry.message),
			["first", "second"],
		);
	});
});

test("a crash loop cannot fill the disk", () => {
	withTempUserData(userDataPath => {
		writeWhiteboardBootstrapBreadcrumb(userDataPath, new Error("first"));
		const file = whiteboardBootstrapBreadcrumbPath(userDataPath);
		writeFileSync(file, `${"x".repeat(70 * 1024)}\n`, "utf8");
		writeWhiteboardBootstrapBreadcrumb(userDataPath, new Error("dropped"));
		assert.equal(readFileSync(file, "utf8").includes("dropped"), false);
	});
});

test("recording a crash never raises one", () => {
	assert.doesNotThrow(() => {
		writeWhiteboardBootstrapBreadcrumb("", undefined);
		writeWhiteboardBootstrapBreadcrumb("\0invalid", new Error("boom"));
	});
	assert.deepEqual(drainWhiteboardBootstrapBreadcrumbs("\0invalid"), []);
});

test("one unreadable line does not lose the others", () => {
	withTempUserData(userDataPath => {
		writeWhiteboardBootstrapBreadcrumb(userDataPath, new Error("kept"));
		const file = whiteboardBootstrapBreadcrumbPath(userDataPath);
		writeFileSync(file, `not json\n${readFileSync(file, "utf8")}`, "utf8");
		assert.deepEqual(
			drainWhiteboardBootstrapBreadcrumbs(userDataPath).map(entry => entry.message),
			["kept"],
		);
	});
});
