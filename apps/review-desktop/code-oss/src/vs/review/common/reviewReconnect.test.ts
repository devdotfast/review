/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import {
	REVIEW_CLIENT_RECONNECT_DELAYS,
	reconnectUntilAborted,
} from "./reviewReconnect.js";

function failing(times: number): (onConnected: () => void) => Promise<void> {
	let calls = 0;
	return async () => {
		calls += 1;
		if (calls <= times) throw new Error(`failure ${calls}`);
	};
}

test("walks the delay table between failures and returns once connect resolves", async () => {
	const waits: number[] = [];
	const errors: string[] = [];
	await reconnectUntilAborted(new AbortController().signal, failing(3), {
		onRetry: (error) => errors.push((error as Error).message),
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	assert.deepEqual(waits, REVIEW_CLIENT_RECONNECT_DELAYS.slice(0, 3));
	assert.deepEqual(errors, ["failure 1", "failure 2", "failure 3"]);
});

test("keeps retrying at the last delay when no exhaustion handler is given", async () => {
	const waits: number[] = [];
	const total = REVIEW_CLIENT_RECONNECT_DELAYS.length + 2;
	await reconnectUntilAborted(new AbortController().signal, failing(total), {
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	const last = REVIEW_CLIENT_RECONNECT_DELAYS[REVIEW_CLIENT_RECONNECT_DELAYS.length - 1];
	assert.deepEqual(waits, [...REVIEW_CLIENT_RECONNECT_DELAYS, last, last]);
});

test("calls onExhausted with the last error once the table runs out", async () => {
	const waits: number[] = [];
	await assert.rejects(
		reconnectUntilAborted(
			new AbortController().signal,
			failing(REVIEW_CLIENT_RECONNECT_DELAYS.length + 1),
			{
				onExhausted: (error) => {
					throw new Error("exhausted", { cause: error });
				},
				wait: async (ms) => {
					waits.push(ms);
				},
			},
		),
		(error: Error) =>
			error.message === "exhausted" &&
			(error.cause as Error).message ===
				`failure ${REVIEW_CLIENT_RECONNECT_DELAYS.length + 1}`,
	);
	assert.deepEqual(waits, [...REVIEW_CLIENT_RECONNECT_DELAYS]);
});

test("a successful connection restarts the delay table", async () => {
	const waits: number[] = [];
	let calls = 0;
	await reconnectUntilAborted(
		new AbortController().signal,
		async (onConnected) => {
			calls += 1;
			if (calls === 1) throw new Error("first");
			if (calls === 2) {
				onConnected();
				throw new Error("stream ended");
			}
		},
		{
			wait: async (ms) => {
				waits.push(ms);
			},
		},
	);
	const first = REVIEW_CLIENT_RECONNECT_DELAYS[0];
	assert.deepEqual(waits, [first, first]);
});

test("returns quietly when the signal aborts during a failure", async () => {
	const controller = new AbortController();
	let waited = false;
	await reconnectUntilAborted(
		controller.signal,
		async () => {
			controller.abort();
			throw new Error("aborted mid-connect");
		},
		{
			onRetry: () => assert.fail("must not retry after abort"),
			wait: async () => {
				waited = true;
			},
		},
	);
	assert.equal(waited, false);
});
