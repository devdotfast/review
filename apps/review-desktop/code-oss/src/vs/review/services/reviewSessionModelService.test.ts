/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import {
	loadReviewDocumentData,
	loadReviewSoftwareMaps,
} from "../browser/parts/canvas/reviewDocumentData.js";
import {
	loadReviewSessionDocument,
	loadReviewSessionSoftwareMap,
	type ReviewDesktopSession,
} from "./reviewSessionModelService.js";

const reviewUuid = "11111111-1111-4111-8111-111111111111";
const session = {
	serverUrl: "http://127.0.0.1:5570",
	sessionUrl: "http://127.0.0.1:5570/sessions/session-1",
	token: "secret-token",
	descriptor: { routePath: "/docs/review.mdx" },
	session: { routePath: "/docs/review.mdx" },
} as ReviewDesktopSession;

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

test("loads document JSON into a ready state", async (t) => {
	const documentUrl =
		"http://127.0.0.1:5570/sessions/session-1/__progressive-review/documents/document-hash.json";
	const data = { format: "review-document/1", body: [] };
	const requests: string[] = [];
	mockFetch(t, async (input, init) => {
		requests.push(String(input));
		assert.equal(
			new Headers(init?.headers).get("x-review-token"),
			"secret-token",
		);
		if (requests.length === 1) {
			assert.ok(init?.signal);
			return Response.json({
				ok: true,
				contentHash: "document-hash",
				documentUrl,
			});
		}
		return Response.json(data);
	});

	const load = await loadReviewSessionDocument(session, loadReviewDocumentData);

	assert.deepEqual(load, {
		state: "ready",
		contentHash: "document-hash",
		data,
	});
	assert.deepEqual(requests, [
		"http://127.0.0.1:5570/sessions/session-1/__progressive-review/document?document=%2Fdocs%2Freview.mdx",
		documentUrl,
	]);
});

test("turns document republish metadata into a needs-republish state", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{
				ok: false,
				code: "needs_republish",
				error: "republish",
				reviewUuid,
				mapStale: true,
			},
			{ status: 409 },
		),
	);

	const load = await loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, {
		state: "needs-republish",
		reviewUuid,
		mapStale: true,
	});
});

test("document loading never rejects and reports other failures as unavailable", async (t) => {
	mockFetch(t, async () => {
		throw new Error("network down");
	});

	const load = await loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, {
		state: "unavailable",
		message: "network down",
	});
});

test("reports other document statuses as unavailable", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{ ok: false, error: "document exploded", code: "internal_error" },
			{ status: 500 },
		),
	);

	const load = await loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, {
		state: "unavailable",
		message: "document exploded",
	});
});

test("loads software-map JSON into a ready state", async (t) => {
	const headMapUrl =
		"http://127.0.0.1:5570/sessions/session-1/__progressive-review/software-maps/map-hash/head.json";
	const baseMapUrl =
		"http://127.0.0.1:5570/sessions/session-1/__progressive-review/software-maps/map-hash/base.json";
	mockFetch(t, async (input) => {
		const url = String(input);
		if (url === headMapUrl) return Response.json({ elements: ["head"] });
		if (url === baseMapUrl) return Response.json({ elements: ["base"] });
		return Response.json({
			ok: true,
			contentHash: "map-hash",
			headMapUrl,
			baseMapUrl,
		});
	});

	const load = await loadReviewSessionSoftwareMap(session, loadReviewSoftwareMaps);

	assert.deepEqual(load, {
		state: "ready",
		contentHash: "map-hash",
		head: { elements: ["head"] },
		base: { elements: ["base"] },
	});
});

test("keeps an unpublished software map as null", async (t) => {
	mockFetch(t, async () => new Response(null, { status: 404 }));

	assert.equal(
		await loadReviewSessionSoftwareMap(session, async () => {
			throw new Error("loader must not run");
		}),
		null,
	);
});

test("turns stale software-map metadata into a needs-republish state", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{
				ok: false,
				code: "needs_republish",
				error: "republish",
				reviewUuid,
				mapStale: true,
			},
			{ status: 409 },
		),
	);

	const load = await loadReviewSessionSoftwareMap(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, { state: "needs-republish", reviewUuid });
});

test("reports other software-map failures as unavailable", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{ ok: false, error: "map exploded", code: "internal_error" },
			{ status: 500 },
		),
	);

	const load = await loadReviewSessionSoftwareMap(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, {
		state: "unavailable",
		message: "map exploded",
	});
});
