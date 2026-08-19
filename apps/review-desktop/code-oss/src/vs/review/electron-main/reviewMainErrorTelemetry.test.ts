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
