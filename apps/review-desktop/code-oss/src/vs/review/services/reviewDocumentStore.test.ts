/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewDocumentSnapshot } from "../common/reviewProtocol.js";
import { ReviewDocumentStore } from "./reviewDocumentStore.js";

const reviewId = "11111111-1111-4111-8111-111111111111";

test("keeps unchanged node identities and ignores stale snapshots", () => {
	const overview = {
		id: "overview",
		kind: "markdown" as const,
		content: "Overview",
	};
	const store = new ReviewDocumentStore(snapshot(1, [overview]));
	let changes = 0;
	const subscription = store.subscribe(() => {
		changes += 1;
	});

	store.replace(
		snapshot(2, [
			{ id: "intro", kind: "callout", content: "New" },
			{ ...overview },
		]),
	);
	const current = store.getSnapshot();
	assert.equal(current.revision, 2);
	assert.strictEqual(current.nodes?.[1], overview);
	assert.equal(changes, 1);

	store.replace(snapshot(1, [{ ...overview, content: "stale" }]));
	assert.strictEqual(store.getSnapshot(), current);
	assert.equal(changes, 1);

	subscription.dispose();
	store.dispose();
});

function snapshot(
	revision: number,
	nodes: NonNullable<ReviewDocumentSnapshot["nodes"]>,
): ReviewDocumentSnapshot {
	return {
		reviewId,
		routePath: "/",
		mode: "incremental",
		revision,
		sourceHash: `hash-${revision}`,
		source: "",
		nodes,
	};
}
