/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Emitter, Event } from "../../base/common/event.js";
import type { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type {
	ReviewDescriptor,
	ReviewSessionDescriptor,
	ReviewSessionWire,
} from "../common/reviewProtocol.js";
import {
	ReviewSessionModelService,
} from "./reviewSessionModelService.js";
import type {
	IReviewSessionService,
	ReviewDataChangedEvent,
	ReviewSessionConnection,
} from "./reviewSessionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const serverOrigin = "http://127.0.0.1:5000";

function makeReview(
	overrides: Partial<ReviewDescriptor> = {},
): ReviewDescriptor {
	return {
		uuid,
		title: "Review",
		status: "awaiting-review",
		worktreePath: "/tmp/review",
		repoKey: "repo",
		sourceBranch: "feature",
		presentedDocumentRevision: "a".repeat(40),
		presentedSoftwareMapRevision: null,
		lastPublishedAt: "2026-08-25T00:00:00.000Z",
		available: true,
		viewedAt: null,
		dismissedAt: null,
		reapsAt: null,
		...overrides,
	};
}

function makeSessionWire(sessionId: string): ReviewSessionWire {
	return {
		sessionId,
		storageDir: `/tmp/storage/${sessionId}`,
		rootPath: "/tmp/root",
		baseRef: "base",
		headRef: "head",
		appUrl: serverOrigin,
		reviewPath: "/tmp/review",
		routePath: "/",
		startedAt: 1,
	};
}

interface StubSessionService extends IReviewSessionService {
	openReviewCalls: number;
	clearSessions(): void;
	replaceSessions(sessions: ReviewSessionDescriptor[]): void;
	fireDidChangeLists(): void;
	fireDidChangeReviewData(event: ReviewDataChangedEvent): void;
}

interface Fixture {
	modelService: ReviewSessionModelService;
	sessionService: StubSessionService;
	sessionWires: Map<string, ReviewSessionWire>;
	readonly fetchCalls: number;
}

function createStubSessionService(review: ReviewDescriptor): {
	service: StubSessionService;
	sessionWires: Map<string, ReviewSessionWire>;
} {
	const sessionWires = new Map<string, ReviewSessionWire>();
	const onDidChangeLists = new Emitter<void>();
	const onDidChangeReviewData = new Emitter<ReviewDataChangedEvent>();
	const sessions: ReviewSessionDescriptor[] = [];
	const reviews: ReviewDescriptor[] = [review];

	const service = {
		_serviceBrand: undefined,
		onDidChangeLists: onDidChangeLists.event,
		onDidChangeReviewData: onDidChangeReviewData.event,
		onDidCloseSession: Event.None,
		onDidCommitReviewThreads: Event.None,
		onDidRegisterSession: Event.None,
		onDidDismissReview: Event.None,
		onDidDeleteReview: Event.None,
		onDidFail: Event.None,
		get sessions() {
			return sessions;
		},
		get reviews() {
			return reviews;
		},
		reviewErrors: [],
		tutorialReview: undefined,
		openReviewCalls: 0,
		async initialize() {},
		async getConnection(): Promise<ReviewSessionConnection> {
			return { serverUrl: serverOrigin, token: "token" };
		},
		async refresh() {},
		async openReview(
			reviewUuid: string,
			_options?: { background?: boolean; revision?: string },
		): Promise<ReviewSessionDescriptor> {
			service.openReviewCalls += 1;
			const sessionId = `session-${service.openReviewCalls}`;
			const descriptor: ReviewSessionDescriptor = {
				sessionId,
				sessionUrl: `${serverOrigin}/sessions/${sessionId}`,
				reviewUuid,
				routePath: "/",
				startedAt: 1,
			};
			sessions.push(descriptor);
			sessionWires.set(sessionId, makeSessionWire(sessionId));
			return descriptor;
		},
		async closeSession() {},
		async deleteReview() {},
		async dismissReview() {},
		async restoreReview() {},
		async readDismissedRetentionDays() {
			return null;
		},
		async setDismissedRetentionDays() {
			return null;
		},
		async getTutorialStatus() {
			return { version: 1 as const, reviewUuid: null };
		},
		async prepareTutorial() {},
		async openTutorial() {
			return {} as never;
		},
		async deleteTutorial() {},
		async getCliInstallStatus() {
			return {} as never;
		},
		async applyCliInstall() {
			return {} as never;
		},
		async removeCliInstall() {},
		async declineCliInstall() {},
		async skipCliInstallPrompts() {},
		async resetCliInstallPrompts() {},
		attachControl() {},
		clearSessions() {
			sessions.length = 0;
		},
		replaceSessions(next: ReviewSessionDescriptor[]) {
			sessions.length = 0;
			sessions.push(...next);
		},
		fireDidChangeLists() {
			onDidChangeLists.fire();
		},
		fireDidChangeReviewData(event: ReviewDataChangedEvent) {
			onDidChangeReviewData.fire(event);
		},
	} as unknown as StubSessionService;

	return { service, sessionWires };
}

function createFixture(
	t: { after(callback: () => void): void },
	review: ReviewDescriptor = makeReview(),
): Fixture {
	const { service, sessionWires } = createStubSessionService(review);
	const instantiationService = {
		createInstance: <Ctor extends new (...args: unknown[]) => unknown>(
			ctor: Ctor,
			...args: unknown[]
		) => new ctor(...args),
	} as unknown as IInstantiationService;
	const modelService = new ReviewSessionModelService(
		instantiationService,
		service,
	);
	let fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetchCalls += 1;
		const url = String(input);
		const match = /\/sessions\/([^/]+)\//.exec(url);
		const sessionId = match?.[1] ?? "session-1";
		const session = sessionWires.get(sessionId) ?? makeSessionWire(sessionId);
		return Response.json({ ok: true, session, token: "token" });
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
		modelService.dispose();
	});
	return {
		modelService,
		sessionService: service,
		sessionWires,
		get fetchCalls() {
			return fetchCalls;
		},
	};
}

test("reopen after the cached model's session vanished re-opens a fresh session", async (t) => {
	const fixture = createFixture(t);
	const { modelService, sessionService } = fixture;

	const ref1 = await modelService.acquire(uuid);
	assert.equal(ref1.object.state, "active");
	assert.equal(ref1.object.session.session.sessionId, "session-1");
	assert.equal(sessionService.openReviewCalls, 1);
	assert.equal(fixture.fetchCalls, 1);

	// Simulate the post-restart state an OOM/native-fault no-broadcast exit
	// produces: the server holds no in-memory sessions, and onDidChangeLists
	// fires (refreshLists) without onDidCloseSession (no session-closed frame).
	sessionService.clearSessions();
	sessionService.fireDidChangeLists();

	// The cached model stays "active" bound to the dead session-1 and does not
	// self-recover (shouldRefreshModel returns false for a vanished in-progress
	// session whose review still exists).
	assert.equal(ref1.object.state, "active");
	assert.equal(ref1.object.session.session.sessionId, "session-1");
	assert.equal(sessionService.openReviewCalls, 1);

	// Closing the tab drops the reference; destroyModel's non-historical branch
	// keeps the stale entry in the cache.
	ref1.dispose();

	// Reopen from the Home list (no preferredSessionId): the fix evicts the
	// dead cached model and re-opens a fresh session for the review.
	const ref2 = await modelService.acquire(uuid);
	assert.notEqual(ref2.object, ref1.object, "reopen must not pin the dead model");
	assert.equal(ref2.object.state, "active");
	assert.equal(ref2.object.session.session.sessionId, "session-2");
	assert.equal(sessionService.openReviewCalls, 2, "reopen must re-run openReview");
	assert.equal(fixture.fetchCalls, 2, "reopen must re-fetch the session descriptor");

	ref2.dispose();
});

test("reopen while the cached model's session is still alive reuses the cache (no regression)", async (t) => {
	const fixture = createFixture(t);
	const { modelService, sessionService } = fixture;

	const ref1 = await modelService.acquire(uuid);
	const first = ref1.object;
	assert.equal(sessionService.openReviewCalls, 1);
	assert.equal(fixture.fetchCalls, 1);

	// The session is still present in sessionService.sessions; the cache hit
	// path must reuse the live model verbatim and never re-run openReview.
	ref1.dispose();

	const ref2 = await modelService.acquire(uuid);
	assert.equal(ref2.object, first, "live cache hit reuses the same model");
	assert.equal(ref2.object.session.session.sessionId, "session-1");
	assert.equal(sessionService.openReviewCalls, 1, "no re-open for a live session");
	assert.equal(fixture.fetchCalls, 1, "no re-fetch for a live session");

	ref2.dispose();
});

test("a preferredSessionId on a live cache hit refreshes without re-opening", async (t) => {
	const fixture = createFixture(t);
	const { modelService, sessionService, sessionWires } = fixture;

	const ref1 = await modelService.acquire(uuid);
	const first = ref1.object;
	const session1 = sessionService.sessions[0];
	assert.equal(sessionService.openReviewCalls, 1);
	ref1.dispose();

	// Register a second live session for the same review as the preferred one,
	// keeping the cached model's session-1 alive too.
	const preferred: ReviewSessionDescriptor = {
		sessionId: "preferred-1",
		sessionUrl: `${serverOrigin}/sessions/preferred-1`,
		reviewUuid: uuid,
		routePath: "/",
		startedAt: 2,
	};
	sessionService.replaceSessions([session1, preferred]);
	sessionWires.set("preferred-1", makeSessionWire("preferred-1"));

	const ref2 = await modelService.acquire(uuid, "preferred-1");
	// refresh resolves the preferred session; the cached model is reused and
	// openReview is not called.
	assert.equal(ref2.object, first, "live cache hit reuses the same model");
	assert.equal(
		ref2.object.session.session.sessionId,
		"preferred-1",
		"refresh rebinds the model to the preferred session",
	);
	assert.equal(sessionService.openReviewCalls, 1, "refresh must not call openReview");
	assert.equal(fixture.fetchCalls, 2, "refresh re-fetches the preferred session");

	ref2.dispose();
});

test("the stale model is disposed when dropped, so it stops reacting to global events", async (t) => {
	const { modelService, sessionService } = createFixture(t);

	const ref1 = await modelService.acquire(uuid);
	const dead = ref1.object;
	let deadChanges = 0;
	dead.onDidChange(() => {
		deadChanges += 1;
	});

	// Crash: sessions reset; the dead model cannot self-recover.
	sessionService.clearSessions();
	sessionService.fireDidChangeLists();
	ref1.dispose();

	// Reopen evicts and disposes the dead model, opening a fresh one.
	const ref2 = await modelService.acquire(uuid);
	let liveChanges = 0;
	ref2.object.onDidChange(() => {
		liveChanges += 1;
	});

	// Both models share the review uuid and would be "active"; only the live
	// model's subscription survives because the stale one was disposed.
	sessionService.fireDidChangeReviewData({
		event: "review-data-changed",
		uuid,
		sessionId: "session-1",
	});
	sessionService.fireDidChangeReviewData({
		event: "review-data-changed",
		uuid,
		sessionId: "session-2",
	});

	assert.equal(deadChanges, 0, "disposed stale model must not react to events");
	assert.equal(liveChanges, 2, "fresh model must react to global events");

	ref2.dispose();
});
