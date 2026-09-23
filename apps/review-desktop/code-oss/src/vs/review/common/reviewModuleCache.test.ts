/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewModuleCache } from "./reviewModuleCache.js";

test("concurrent loads of one key share a single loader call", async () => {
	const cache = new ReviewModuleCache();
	let calls = 0;
	const loader = async () => {
		calls += 1;
		return "module";
	};
	const [first, second] = await Promise.all([
		cache.load("a", loader),
		cache.load("a", loader),
	]);
	assert.equal(first, "module");
	assert.equal(second, "module");
	assert.equal(calls, 1);
	assert.equal(await cache.load("a", loader), "module");
	assert.equal(calls, 1);
});

test("a rejected load is evicted so the next caller retries", async () => {
	const cache = new ReviewModuleCache();
	let calls = 0;
	const loader = async () => {
		calls += 1;
		if (calls === 1) throw new Error("boom");
		return "recovered";
	};
	await assert.rejects(cache.load("a", loader), /boom/);
	assert.equal(await cache.load("a", loader), "recovered");
	assert.equal(calls, 2);
});

test("a loader that throws synchronously rejects instead of throwing", async () => {
	const cache = new ReviewModuleCache();
	await assert.rejects(
		cache.load("a", () => {
			throw new Error("sync");
		}),
		/sync/,
	);
});

test("clear forces the next load to run the loader again", async () => {
	const cache = new ReviewModuleCache();
	let calls = 0;
	const loader = async () => ++calls;
	assert.equal(await cache.load("a", loader), 1);
	cache.clear();
	assert.equal(await cache.load("a", loader), 2);
});
