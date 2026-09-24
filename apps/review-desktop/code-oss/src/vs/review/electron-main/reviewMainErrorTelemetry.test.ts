/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewMainErrorTelemetry } from "./reviewMainErrorTelemetry.js";

test("posts named main-process telemetry through the embedded server", async () => {
  const requests: RequestInit[] = [];
  const telemetry = new ReviewMainErrorTelemetry({
    whenConnected: async () => ({
      version: 3,
      url: "http://127.0.0.1:1234/__progressive-review",
      token: "secret",
      instanceId: "instance",
      appSessionId: "launch-1",
    }),
    isTelemetryEnabled: () => true,
    fetchImpl: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    },
  });
  telemetry.capture(
    "update_failed",
    { phase: "download", message_source: "electron" },
    {
      name: "UpdateDownloadError",
      message: "Download failed",
      stack: "Update lifecycle telemetry",
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(
    new Headers(requests[0].headers).get("x-review-app-session-id"),
    "launch-1",
  );
  assert.deepEqual(JSON.parse(String(requests[0].body)), {
    name: "update_failed",
    properties: { phase: "download", message_source: "electron" },
    error: {
      name: "UpdateDownloadError",
      message: "Download failed",
      stack: "Update lifecycle telemetry",
    },
  });
  telemetry.dispose();
});

test("queues an event captured before the server connects and posts it once", async () => {
  let connect!: () => void;
  const connected = new Promise<void>((resolve) => (connect = resolve));
  const requests: RequestInit[] = [];
  const telemetry = new ReviewMainErrorTelemetry({
    whenConnected: async () => {
      await connected;
      return {
        version: 3,
        url: "http://127.0.0.1:1234/__progressive-review",
        token: "secret",
        instanceId: "instance",
        appSessionId: "launch-1",
      };
    },
    isTelemetryEnabled: () => true,
    fetchImpl: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    },
  });
  telemetry.capture("crash", { process: "renderer", reason: "oom", exit_code: -1, uptime_ms: 1, source: "live" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);

  connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(String(requests[0].body)).name, "crash");
  telemetry.dispose();
});
