/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { whiteboardTelemetryEventRequest } from "./whiteboardTelemetryRequest.js";

test("builds an authenticated JSON POST for a telemetry event", () => {
	const request = whiteboardTelemetryEventRequest(
		{ token: "secret", appSessionId: "app-1" },
		{ name: "review_presented" },
	);
	assert.equal(request.method, "POST");
	assert.deepEqual(request.headers, {
		"content-type": "application/json",
		"x-whiteboard-token": "secret",
		"x-review-app-session-id": "app-1",
	});
	assert.deepEqual(JSON.parse(String(request.body)), { name: "review_presented" });
	assert.equal(request.keepalive, false);
});

test("keepalive is opt-in", () => {
	const request = whiteboardTelemetryEventRequest(
		{ token: "secret", appSessionId: "app-1" },
		{ name: "x" },
		{ keepalive: true },
	);
	assert.equal(request.keepalive, true);
});
