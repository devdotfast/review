/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Emitter, Event } from "../../base/common/event.js";
import {
	loadReviewSessionCanvasDocument,
	type ReviewDesktopSession,
	ReviewSessionModel,
} from "./reviewSessionModelService.js";
import type { ReviewDocumentAuthoringTargetChangedEvent } from "./reviewSessionService.js";

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

test("forwards ephemeral authoring targets into the incremental document store", async () => {
	const targets = new Emitter<ReviewDocumentAuthoringTargetChangedEvent>();
	const model = new TestReviewSessionModel(targets);
	const content = await model.resolveDocument(async () => ({}));
	assert.equal(content.kind, "incremental");
	if (content.kind !== "incremental") return;

	targets.fire({
		event: "review-document-authoring-target-changed",
		uuid: "11111111-1111-4111-8111-111111111111",
		routePath: "/",
		targetNodeId: "summary",
	});
	assert.equal(content.store.getAuthoringTargetNodeId(), "summary");

	targets.fire({
		event: "review-document-authoring-target-changed",
		uuid: "11111111-1111-4111-8111-111111111111",
		routePath: "/",
		targetNodeId: null,
	});
	assert.equal(content.store.getAuthoringTargetNodeId(), null);

	model.dispose();
	targets.dispose();
});

class TestReviewSessionModel extends ReviewSessionModel {
	constructor(
		targets: Emitter<ReviewDocumentAuthoringTargetChangedEvent>,
	) {
		const current = session();
		super(
			"11111111-1111-4111-8111-111111111111",
			current,
			async () => current,
			Event.None,
			Event.None,
			Event.None,
			() => true,
			Event.None,
			Event.None,
			targets.event,
		);
	}

	override async request(): Promise<Response> {
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
	}
}

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
