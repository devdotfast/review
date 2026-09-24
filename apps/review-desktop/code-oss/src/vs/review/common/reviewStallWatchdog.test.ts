/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { startStallWatchdog } from "./reviewStallWatchdog.js";

function harness() {
	let now = 0;
	let visible = true;
	let tick: (() => void) | undefined;
	let visibilityListener: (() => void) | undefined;
	const stalls: number[] = [];
	const stop = startStallWatchdog({
		onStall: (ms) => stalls.push(ms),
		now: () => now,
		schedule: (fn) => { tick = fn; return () => { tick = undefined; }; },
		isVisible: () => visible,
		onVisibilityChange: (listener) => { visibilityListener = listener; return () => { visibilityListener = undefined; }; },
		maxReports: 2,
	});
	return {
		advance: (ms: number) => { now += ms; tick?.(); },
		elapse: (ms: number) => { now += ms; },
		setVisible: (value: boolean) => { visible = value; visibilityListener?.(); },
		stalls,
		stop,
		isScheduled: () => tick !== undefined,
		isWatchingVisibility: () => visibilityListener !== undefined,
	};
}

test("reports a tick that arrives two seconds late, at most twice", () => {
	const h = harness();
	h.advance(500);
	h.advance(600);
	assert.deepEqual(h.stalls, []);
	h.advance(3_000);
	h.advance(2_600);
	assert.deepEqual(h.stalls, [2_500, 2_100]);
	assert.equal(h.isScheduled(), false, 'the last report stops the timer');
	assert.equal(h.isWatchingVisibility(), false);
	h.advance(9_000);
	assert.deepEqual(h.stalls, [2_500, 2_100]);
});

test("stopping cancels the timer and the visibility listener", () => {
	const h = harness();
	h.stop();
	assert.equal(h.isScheduled(), false);
	assert.equal(h.isWatchingVisibility(), false);
});

test("ignores late ticks while the window is hidden", () => {
	const h = harness();
	h.setVisible(false);
	h.advance(10_000);
	h.advance(30_000);
	assert.deepEqual(h.stalls, []);
});

test("restarts the measurement when the window becomes visible again", () => {
	const h = harness();
	h.setVisible(false);
	h.elapse(20_000);
	h.setVisible(true);
	h.advance(500);
	assert.deepEqual(h.stalls, []);
	h.advance(3_000);
	assert.deepEqual(h.stalls, [2_500]);
});

test("discards a lag over a minute, which is a sleep rather than a stall", () => {
	const h = harness();
	h.advance(90_000);
	assert.deepEqual(h.stalls, []);
});
