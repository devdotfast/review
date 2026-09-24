/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ReviewCrashTelemetry } from "./reviewCrashTelemetry.js";
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

function connection() {
  return {
    version: 3,
    url: "http://127.0.0.1:1234/__progressive-review",
    token: "secret",
    instanceId: "instance",
    appSessionId: "launch-1",
  } as const;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a server crash captured while the server is down is sent once after it restarts, and only then counted", async () => {
  let serverUp = true;
  const delivered: string[] = [];
  const recorded: number[] = [];
  const telemetry = new ReviewMainErrorTelemetry({
    whenConnected: async () => connection(),
    isTelemetryEnabled: () => true,
    fetchImpl: async (_input, init) => {
      if (!serverUp) throw new TypeError("fetch failed");
      delivered.push(JSON.parse(String(init?.body)).properties.process);
      return new Response(null, { status: 204 });
    },
  });
  const crashes = new ReviewCrashTelemetry({
    app: new EventEmitter() as never,
    capture: (name, properties, onDelivered) => telemetry.capture(name, properties, undefined, onDelivered),
    now: () => 9_000,
    launchedAt: 1_000,
    onCrashRecorded: (at) => recorded.push(at),
  });
  await settle();

  serverUp = false;
  telemetry.serverLost();
  crashes.reportServerExit({ code: 1, signal: "SIGSEGV", reason: "exit 1 (SIGSEGV)" });
  await settle();
  assert.deepEqual(delivered, []);
  assert.deepEqual(recorded, [], "an undelivered crash must leave its dump to the minidump fallback");

  serverUp = true;
  telemetry.serverReady();
  await settle();
  telemetry.serverReady();
  await settle();
  assert.deepEqual(delivered, ["server"]);
  assert.deepEqual(recorded, [9_000]);
  crashes.dispose();
  telemetry.dispose();
});

test("an event whose send fails is kept and sent after the next ready", async () => {
  let failNext = true;
  const delivered: string[] = [];
  const telemetry = new ReviewMainErrorTelemetry({
    whenConnected: async () => connection(),
    isTelemetryEnabled: () => true,
    fetchImpl: async (_input, init) => {
      if (failNext) {
        failNext = false;
        throw new TypeError("fetch failed");
      }
      delivered.push(JSON.parse(String(init?.body)).name);
      return new Response(null, { status: 204 });
    },
  });
  await settle();
  // The server died before the supervisor noticed.
  telemetry.capture("crash", { process: "renderer" });
  await settle();
  assert.deepEqual(delivered, []);

  telemetry.serverReady();
  await settle();
  assert.deepEqual(delivered, ["crash"]);
  telemetry.dispose();
});
