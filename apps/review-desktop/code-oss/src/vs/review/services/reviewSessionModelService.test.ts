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
import { ReviewModuleCache } from "../common/reviewModuleCache.js";
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

test("preserves historical navigation metadata without loading code", async (t) => {
	mockFetch(t, async () => Response.json({
		ok: false,
		error: "This older revision is unavailable in this version of Review",
		detail: { code: "historical_revision_unavailable", reviewUuid },
	}, { status: 409 }));
	const loader = async (): Promise<never> => {
		throw new Error("loader must not run");
	};
	const expected = {
		state: "unavailable",
		message: "This older revision is unavailable in this version of Review",
		currentReviewUuid: reviewUuid,
	};
	assert.deepEqual(await loadReviewSessionDocument(session, loader), expected);
	assert.deepEqual(await loadReviewSessionSoftwareMap(session, loader), expected);
});

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
				error: "republish",
				detail: { code: "needs_republish", reviewUuid, mapStale: true },
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

test("rejects document transport failures so the same revision can retry", async (t) => {
	mockFetch(t, async () => {
		throw new Error("network down");
	});

	await assert.rejects(loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	}), /network down/);
});

test("reports a missing document endpoint as unavailable", async (t) => {
	mockFetch(t, async () => new Response(null, { status: 404 }));

	const load = await loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, {
		state: "unavailable",
		message: "Review document returned 404.",
	});
});

test("rejects unexpected document statuses", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{ ok: false, error: "document exploded", code: "internal_error" },
			{ status: 500 },
		),
	);

	await assert.rejects(loadReviewSessionDocument(session, async () => {
		throw new Error("loader must not run");
	}), /document exploded/);
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
				error: "republish",
				detail: { code: "needs_republish", reviewUuid, mapStale: true },
			},
			{ status: 409 },
		),
	);

	const load = await loadReviewSessionSoftwareMap(session, async () => {
		throw new Error("loader must not run");
	});

	assert.deepEqual(load, { state: "needs-republish", reviewUuid });
});

test("rejects unexpected software-map failures", async (t) => {
	mockFetch(t, async () =>
		Response.json(
			{ ok: false, error: "map exploded", code: "internal_error" },
			{ status: 500 },
		),
	);

	await assert.rejects(loadReviewSessionSoftwareMap(session, async () => {
		throw new Error("loader must not run");
	}), /map exploded/);
});

for (const kind of ["document", "software-map"] as const) {
  for (const failure of ["busy", "transport", "invalid-envelope", "invalid-json", "artifact-json"] as const) {
    test(`${kind} retries the same cache key after ${failure}`, async (t) => {
      const cache = new ReviewModuleCache();
      let failing = true;
      const artifact = `${session.sessionUrl}/artifact.json`;
      mockFetch(t, async (input) => {
        if (String(input) === artifact) {
          return failing && failure === "artifact-json" ? new Response("{") : Response.json({});
        }
        if (failing) {
          if (failure === "transport") throw new Error("offline");
          if (failure === "busy") return Response.json({ ok: false, error: "busy", code: "review_busy", retryable: true }, { status: 409 });
          if (failure === "invalid-envelope") return Response.json({ ok: true });
          if (failure === "invalid-json") return new Response("{");
        }
        return Response.json(kind === "document"
          ? { ok: true, contentHash: "same", documentUrl: artifact }
          : { ok: true, contentHash: "same", headMapUrl: artifact, baseMapUrl: artifact });
      });
      const load = () => kind === "document"
        ? cache.load(kind, () => loadReviewSessionDocument(session, loadReviewDocumentData))
        : cache.load(kind, () => loadReviewSessionSoftwareMap(session, loadReviewSoftwareMaps));
      await assert.rejects(load());
      failing = false;
      assert.equal((await load())?.state, "ready");
    });
  }
}
