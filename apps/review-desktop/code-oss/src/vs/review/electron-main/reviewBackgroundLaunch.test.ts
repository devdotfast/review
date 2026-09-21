/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { FocusMode } from "../../platform/native/common/native.js";
import { ReviewBackgroundLaunch } from "./reviewBackgroundLaunch.js";

test("a normal launch never suppresses focus", () => {
	const launch = new ReviewBackgroundLaunch({});
	assert.equal(launch.suppressesFocus, false);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), true);
});

test("a background launch suppresses transfer focus until released", () => {
	const launch = new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1" });
	assert.equal(launch.suppressesFocus, true);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), false);
	assert.equal(launch.allowsFocus(FocusMode.Notify), true);
	launch.release();
	assert.equal(launch.suppressesFocus, false);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), true);
});

test("a forced focus releases the gate", () => {
	const launch = new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1" });
	assert.equal(launch.allowsFocus(FocusMode.Force), true);
	assert.equal(launch.suppressesFocus, false);
});

test("only the value 1 marks a background launch", () => {
	assert.equal(new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "0" }).suppressesFocus, false);
	assert.equal(new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "" }).suppressesFocus, false);
});
