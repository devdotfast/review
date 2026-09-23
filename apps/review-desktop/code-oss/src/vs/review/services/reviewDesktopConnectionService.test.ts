/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
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

function serviceWith(storage = new TestStorage()): ReviewDesktopConnectionService {
	const service = new ReviewDesktopConnectionService({} as never, storage as never);
	Object.assign(service, {
		connection: {
			version: 1,
			url: "http://127.0.0.1:5000",
			token: "token",
			instanceId: "instance",
		},
		initializePromise: Promise.resolve(),
	});
	return service;
}

function mockFetch(t: { after(callback: () => void): void }, handler: typeof fetch): void {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("install status shares concurrent scans and detects agents on subsequent checks", async (t) => {
	const service = serviceWith();
	t.after(() => service.dispose());
	let requests = 0;
	mockFetch(t, async () => {
		requests += 1;
		if (requests === 3) return Response.json({ error: "scan failed" }, { status: 500 });
		return Response.json({
			agents: [{ target: "codex", present: requests > 1, installed: false }],
			fingerprint: "test", stamp: null, stale: false,
			shim: { path: "/tmp/review", installed: false, profileConfigured: false, onPath: false },
			fff: { serverName: "fff", corpusRoot: "/tmp/traces", binary: { path: "/tmp/fff", installed: false }, registrations: [] },
			trace: { enabled: false, configured: false, autoActivateRepositories: false, envPath: "/tmp/env", settingsPath: "/tmp/settings" },
			cli: null,
		});
	});

	const [first, second] = await Promise.all([
		service.getCliInstallStatus(),
		service.getCliInstallStatus(),
	]);
	assert.equal(first.agents[0].present, false);
	assert.equal(second.agents[0].present, false);
	assert.equal(requests, 1);
	assert.equal((await service.getCliInstallStatus()).agents[0].present, true);
	assert.equal(requests, 2);
	await assert.rejects(service.getCliInstallStatus(), /scan failed/);
	assert.equal((await service.getCliInstallStatus()).agents[0].present, true);
	assert.equal(requests, 4);
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
				kind: "api",
				reviewUuid: uuid,
				title: "Tutorial",
			});
		}
		return Response.json({ ok: true });
	});

	const deletingService = serviceWith(storage);
	await deletingService.deleteTutorial();
	deletingService.dispose();

	const suppressedService = serviceWith(storage);
	await suppressedService.prepareTutorial();
	assert.equal(requests.length, 1);
	await suppressedService.openTutorial();
	assert.equal(requests.length, 2);
	assert.match(requests[1] ?? "", /POST .*\/tutorial\/open$/);
	suppressedService.dispose();

	const restoredService = serviceWith(storage);
	await restoredService.prepareTutorial();
	assert.equal(requests.length, 3);
	assert.match(requests[2] ?? "", /POST .*\/tutorial\/prepare$/);
	restoredService.dispose();
});

test("passes automatic skill updates to the server without enabling optional integrations", async (t) => {
	const service = serviceWith();
	let requestBody: unknown;
	mockFetch(t, async (_url, init) => {
		requestBody = JSON.parse(String(init?.body));
		return Response.json({ ok: true, output: "updated" });
	});
	await service.applyCliInstall({ targets: ["codex"], shim: false, autoUpdate: true });
	assert.deepEqual(requestBody, { targets: ["codex"], shim: false, autoUpdate: true });
});
