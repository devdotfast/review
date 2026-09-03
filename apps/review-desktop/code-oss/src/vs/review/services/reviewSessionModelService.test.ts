/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Emitter, Event } from "../../base/common/event.js";
import type { ReviewDescriptor } from "../common/reviewProtocol.js";
import {
	type ReviewDesktopSession,
	ReviewSessionModel,
} from "./reviewSessionModelService.js";
import type { ReviewSessionClosedEvent } from "./reviewSessionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const review: ReviewDescriptor = {
	uuid,
	title: "Republished",
	status: "awaiting-review",
	worktreePath: "/tmp/review",
	repoKey: "repo",
	sourceBranch: "feature",
	presentedDocumentRevision: "a".repeat(40),
	presentedSoftwareMapRevision: null,
	lastPublishedAt: "2026-09-03T00:00:00.000Z",
	available: true,
	viewedAt: null,
	dismissedAt: null,
	reapsAt: null,
};

function sessionNamed(sessionId: string): ReviewDesktopSession {
	return {
		serverUrl: "http://127.0.0.1:5000",
		sessionUrl: `http://127.0.0.1:5000/sessions/${sessionId}`,
		token: "token",
		descriptor: {
			sessionId,
			sessionUrl: `http://127.0.0.1:5000/sessions/${sessionId}`,
			reviewUuid: uuid,
			routePath: "/",
			startedAt: 1,
		},
		review,
		session: {
			sessionId,
			storageDir: "/tmp/review-home",
		} as ReviewDesktopSession["session"],
	};
}

function modelWith(successor: ReviewDesktopSession): {
	model: ReviewSessionModel;
	closeSession: Emitter<ReviewSessionClosedEvent>;
	resolved: number;
	changes: number;
} {
	const closeSession = new Emitter<ReviewSessionClosedEvent>();
	const state = { resolved: 0, changes: 0 };
	const model = new ReviewSessionModel(
		uuid,
		sessionNamed("session-1"),
		async () => {
			state.resolved += 1;
			return successor;
		},
		Event.None,
		Event.None,
		closeSession.event,
	);
	model.onDidChange(() => {
		state.changes += 1;
	});
	return {
		model,
		closeSession,
		get resolved() {
			return state.resolved;
		},
		get changes() {
			return state.changes;
		},
	};
}

test("a replaced session moves to its successor without going unavailable", async () => {
	const successor = sessionNamed("session-2");
	const harness = modelWith(successor);

	harness.closeSession.fire({
		session: sessionNamed("session-1").descriptor,
		review,
		reason: "replaced",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(harness.model.state, "active");
	assert.equal(harness.model.session.session.sessionId, "session-2");
	assert.equal(harness.resolved, 1);
	assert.equal(harness.changes, 1);
	harness.model.dispose();
});

test("a closed session goes unavailable", () => {
	const harness = modelWith(sessionNamed("session-2"));

	harness.closeSession.fire({
		session: sessionNamed("session-1").descriptor,
		review,
		reason: "closed",
	});

	assert.equal(harness.model.state, "unavailable");
	assert.match(harness.model.unavailableMessage ?? "", /closed/);
	assert.equal(harness.resolved, 0);
	harness.model.dispose();
});

test("a close for another session is ignored", () => {
	const harness = modelWith(sessionNamed("session-2"));

	harness.closeSession.fire({
		session: sessionNamed("session-9").descriptor,
		review,
		reason: "replaced",
	});

	assert.equal(harness.model.state, "active");
	assert.equal(harness.model.session.session.sessionId, "session-1");
	assert.equal(harness.resolved, 0);
	harness.model.dispose();
});
