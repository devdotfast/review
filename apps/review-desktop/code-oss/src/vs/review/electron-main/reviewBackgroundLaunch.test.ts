/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { FocusMode } from "../../platform/native/common/native.js";
import { ReviewBackgroundLaunch } from "./reviewBackgroundLaunch.js";

const background = { DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1" };

function fakeWindow() {
	const calls: string[] = [];
	let onFocus: (() => void) | undefined;
	return {
		calls,
		focusFromUser: () => onFocus?.(),
		win: {
			show: () => calls.push("show"),
			showInactive: () => calls.push("showInactive"),
			once: (_event: "focus", listener: () => void) => { onFocus = listener; },
		},
	};
}

test("a normal launch leaves window creation and focus alone", () => {
	const launch = new ReviewBackgroundLaunch({});
	const options = { show: true };
	const { win, calls } = fakeWindow();
	launch.prepare(options);
	launch.attach(win);
	launch.show(win);
	assert.equal(options.show, true);
	assert.deepEqual(calls, ["show"]);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), true);
});

test("a background launch shows the first window inactive and swallows focus until the user clicks", () => {
	const launch = new ReviewBackgroundLaunch(background);
	const options = { show: true };
	const { win, calls, focusFromUser } = fakeWindow();
	launch.prepare(options);
	assert.equal(options.show, false);
	launch.attach(win);
	assert.deepEqual(calls, ["showInactive"]);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), false);
	assert.equal(launch.allowsFocus(FocusMode.Notify), true);
	focusFromUser();
	assert.equal(launch.suppressesFocus, false);
	assert.equal(launch.allowsFocus(FocusMode.Transfer), true);
	launch.show(win);
	assert.deepEqual(calls, ["showInactive", "show"]);
});

test("a window that upstream shows later is shown inactive there instead", () => {
	const launch = new ReviewBackgroundLaunch(background);
	const options = { show: false }; // maximized or fullscreen restore
	const { win, calls } = fakeWindow();
	launch.prepare(options);
	launch.attach(win);
	assert.deepEqual(calls, []);
	launch.show(win);
	assert.deepEqual(calls, ["showInactive"]);
});

test("a forced focus releases the gate", () => {
	const launch = new ReviewBackgroundLaunch(background);
	assert.equal(launch.allowsFocus(FocusMode.Force), true);
	assert.equal(launch.suppressesFocus, false);
});

test("only the value 1 marks a background launch", () => {
	assert.equal(new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "0" }).suppressesFocus, false);
	assert.equal(new ReviewBackgroundLaunch({ DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "" }).suppressesFocus, false);
});
