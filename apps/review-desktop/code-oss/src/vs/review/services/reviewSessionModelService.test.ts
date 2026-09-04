/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import {
	loadReviewSessionCanvasDocument,
	type ReviewDesktopSession,
} from "./reviewSessionModelService.js";

test("loads a session-scoped incremental snapshot without importing MDX", async () => {
	let moduleLoads = 0;
	const content = await loadReviewSessionCanvasDocument(
		session(),
		async () => {
			moduleLoads += 1;
			return {};
		},
		async (url) => {
			assert.match(url, /__progressive-review\/document$/);
			return Response.json({
				ok: true,
				snapshot: {
					reviewId: "11111111-1111-4111-8111-111111111111",
					routePath: "/",
					mode: "incremental",
					revision: 2,
					sourceHash: "hash-2",
					source: "source",
					nodes: [
						{ id: "summary", kind: "markdown", content: "# Summary" },
					],
				},
			});
		},
	);

	assert.equal(content.kind, "incremental");
	assert.equal(moduleLoads, 0);
	assert.equal(
		content.kind === "incremental" ? content.store.getSnapshot().revision : -1,
		2,
	);
});

function session(): ReviewDesktopSession {
	return {
		serverUrl: "http://127.0.0.1:5570",
		sessionUrl: "http://127.0.0.1:5570/sessions/test",
		token: "token",
		descriptor: { routePath: "/" },
		review: {},
		session: { sessionId: "test", storageDir: "/tmp/review", routePath: "/" },
	} as ReviewDesktopSession;
}
