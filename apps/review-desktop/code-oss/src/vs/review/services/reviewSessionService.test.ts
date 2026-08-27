/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import type {
	ReviewDescriptor,
	ReviewSessionDescriptor,
} from "../common/reviewProtocol.js";
import { ReviewSessionService } from "./reviewSessionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const review: ReviewDescriptor = {
	uuid,
	title: "Cache me",
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
};
const session: ReviewSessionDescriptor = {
	sessionId: "session-1",
	sessionUrl: "http://127.0.0.1:5000/sessions/session-1",
	reviewUuid: uuid,
	routePath: "/",
	startedAt: 1,
};

class TestStorage {
	private readonly values = new Map<string, boolean>();

	getBoolean(key: string, _scope: unknown, fallback: boolean): boolean {
		return this.values.get(key) ?? fallback;
	}

	store(key: string, value: boolean): void {
		this.values.set(key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
	}
}

function serviceWith(
	reviews: ReviewDescriptor[] = [],
	storage = new TestStorage(),
): ReviewSessionService {
	const service = new ReviewSessionService(
		{} as never,
		{ appSessionId: "app-session" } as never,
		storage as never,
	);
	Object.assign(service, {
		connection: {
			version: 1,
			url: "http://127.0.0.1:5000",
			token: "token",
			instanceId: "instance",
		},
		initializePromise: Promise.resolve(),
		_reviews: reviews,
	});
	return service;
}

function mockFetch(
	t: { after(callback: () => void): void },
	handler: typeof fetch,
): void {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("confirmed dismiss updates the cached review", async (t) => {
	const service = serviceWith([review]);
	mockFetch(t, async () =>
		Response.json({
			ok: true,
			uuid,
			viewedAt: null,
			dismissedAt: "2026-08-25T01:00:00.000Z",
			reapsAt: "2026-09-24T01:00:00.000Z",
		}),
	);

	await service.dismissReview(uuid);

	assert.equal(service.reviews[0]?.dismissedAt, "2026-08-25T01:00:00.000Z");
	service.dispose();
});

test("failed dismiss leaves the cached review unchanged", async (t) => {
	const service = serviceWith([review]);
	mockFetch(t, async () => Response.json({ error: "nope" }, { status: 500 }));

	await assert.rejects(service.dismissReview(uuid), /nope/);

	assert.strictEqual(service.reviews[0], review);
	service.dispose();
});

test("open uses the returned descriptors without listing reviews", async (t) => {
	const service = serviceWith([review]);
	const requests: string[] = [];
	mockFetch(t, async (input) => {
		requests.push(String(input));
		return Response.json({
			sessionId: session.sessionId,
			url: session.sessionUrl,
			session,
			review: { ...review, viewedAt: "2026-08-25T01:00:00.000Z" },
		});
	});

	await service.openReview(uuid);

	assert.deepEqual(requests, [`http://127.0.0.1:5000/reviews/${uuid}/open`]);
	assert.deepEqual(service.sessions[0], session);
	assert.equal(service.reviews[0]?.viewedAt, "2026-08-25T01:00:00.000Z");
	service.dispose();
});

test("tutorial auto-prepare runs at most once per app process", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ ok: true });
	});

	const first = service.prepareTutorial();
	assert.strictEqual(service.prepareTutorial(), first);
	await first;
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("a failed tutorial auto-prepare is not retried on Welcome activation", async (t) => {
	const service = serviceWith();
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		return Response.json({ error: "no agent" }, { status: 409 });
	});

	await assert.rejects(service.prepareTutorial(), /no agent/);
	await service.prepareTutorial();

	assert.equal(requests, 1);
	service.dispose();
});

test("tutorial deletion suppresses auto-prepare across restarts until explicit open", async (t) => {
	const storage = new TestStorage();
	const requests: string[] = [];
	mockFetch(t, async (input, init) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/tutorial/open")) {
			return Response.json({
				reviewUuid: uuid,
				sessionId: session.sessionId,
				url: session.sessionUrl,
				review,
				session,
			});
		}
		return Response.json({ ok: true });
	});

	const deletingService = serviceWith([], storage);
	await deletingService.deleteTutorial();
	deletingService.dispose();

	const suppressedService = serviceWith([], storage);
	await suppressedService.prepareTutorial();
	assert.equal(requests.length, 1);
	await suppressedService.openTutorial();
	assert.deepEqual(suppressedService.tutorialReview, review);
	assert.equal(requests.length, 2);
	assert.match(requests[1] ?? "", /POST .*\/tutorial\/open$/);
	assert.deepEqual(suppressedService.sessions, [session]);
	suppressedService.dispose();

	const restoredService = serviceWith([], storage);
	await restoredService.prepareTutorial();
	assert.equal(requests.length, 3);
	assert.match(requests[2] ?? "", /POST .*\/tutorial\/prepare$/);
	restoredService.dispose();
});
