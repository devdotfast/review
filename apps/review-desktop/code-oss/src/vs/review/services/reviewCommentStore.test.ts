/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import type {
	ReviewCommentThreadRecord,
	ReviewThreadsSnapshot,
} from "../common/reviewProtocol.js";
import { ReviewCommentStore } from "./reviewCommentStore.js";

function thread(threadId: string): ReviewCommentThreadRecord {
	return {
		threadId,
		target: { kind: "document" },
		status: "open",
		messages: [
			{
				id: `${threadId}-message`,
				by: "Reviewer",
				at: "2026-09-01T00:00:00.000Z",
				body: `Body for ${threadId}`,
				agentInput: false,
			},
		],
	};
}

test("projects a commit locally and keeps it across a later snapshot refresh", async () => {
	let snapshot: ReviewThreadsSnapshot = { revision: 0, comments: {}, drafts: {} };
	const store = new ReviewCommentStore({
		request: async (endpoint) => {
			assert.strictEqual(endpoint, "/comments");
			return Response.json({ ok: true, snapshot });
		},
	});
	try {
		await store.refreshPersistedComments();
		assert.deepStrictEqual([...store.getSnapshot().commentThreads.keys()], []);

		const first = thread("repair-thread-1");
		store.applyCommit({
			mutationId: "repair-message-1",
			revision: 1,
			upsertedThreads: [first],
			deletedThreadIds: [],
			upsertedDrafts: [],
			deletedDraftThreadIds: [],
		});
		assert.deepStrictEqual(
			[...store.getSnapshot().commentThreads.keys()],
			["repair-thread-1"],
		);

		const second = thread("repair-thread-2");
		snapshot = {
			revision: 2,
			comments: { "repair-thread-1": first, "repair-thread-2": second },
			drafts: {},
		};
		await store.refreshPersistedComments();
		assert.deepStrictEqual(
			[...store.getSnapshot().commentThreads.keys()],
			["repair-thread-1", "repair-thread-2"],
		);
	} finally {
		store.dispose();
	}
});
