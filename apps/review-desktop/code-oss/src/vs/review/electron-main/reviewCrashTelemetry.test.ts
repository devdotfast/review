/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { REVIEW_SERVER_PROCESS_TYPE } from "./reviewServerSupervisor.js";
import { ReviewCrashTelemetry, type ReviewCrashWindow } from "./reviewCrashTelemetry.js";

function setup(now = () => 10_000, windows: ReviewCrashWindow[] = []) {
  const app = new EventEmitter();
  const captured: Array<[string, Record<string, string | number | boolean>]> = [];
  const recorded: number[] = [];
  const telemetry = new ReviewCrashTelemetry({
    app: app as never,
    windows,
    capture: (name, properties, onDelivered) => {
      captured.push([name, properties]);
      onDelivered?.();
    },
    now,
    launchedAt: 4_000,
    onCrashRecorded: (at) => recorded.push(at),
  });
  return { app, captured, recorded, telemetry };
}

test("counts a renderer crash with its reason and uptime", () => {
  const { app, captured, recorded } = setup();
  app.emit("render-process-gone", {}, {}, { reason: "oom", exitCode: -1 });
  app.emit("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 });
  app.emit("render-process-gone", {}, {}, { reason: "killed", exitCode: 15 });
  assert.deepEqual(captured, [["crash", { process: "renderer", reason: "oom", exit_code: -1, uptime_ms: 6_000, source: "live" }]]);
  assert.deepEqual(recorded, [10_000]);
});

test("maps child processes and the server supervisor, counting the server once", () => {
  const { app, captured, telemetry } = setup();
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5 });
  // The server is a utility process too; its supervisor reports it as "server".
  app.emit("child-process-gone", {}, { type: "Utility", name: `${REVIEW_SERVER_PROCESS_TYPE}-7`, reason: "crashed", exitCode: 11 });
  app.emit("child-process-gone", {}, { type: "Utility", name: "extension host", reason: "oom", exitCode: 3 });
  telemetry.reportServerExit({ code: 1, signal: "SIGSEGV", reason: "exit 1 (SIGSEGV)" });
  telemetry.reportServerExit({ code: 139, reason: "crashed (139)" });
  telemetry.reportServerExit({ code: 1, signal: "unknown", reason: "exit 1 (unknown)" });
  telemetry.reportServerExit({ code: 0, signal: "unknown", reason: "exit 0 (unknown)" });
  assert.deepEqual(captured.map(([, p]) => [p.process, p.reason, p.exit_code]), [
    ["gpu", "crashed", 5],
    ["utility", "oom", 3],
    ["server", "SIGSEGV", 1],
    ["server", "crashed", 139],
    ["server", "exit", 1],
  ]);
});

test("pairs unresponsive and responsive into a hang duration", () => {
  let now = 0;
  const { app, captured } = setup(() => now);
  const win = new EventEmitter();
  app.emit("browser-window-created", {}, win);
  now = 1_000;
  win.emit("unresponsive");
  win.emit("unresponsive");
  now = 4_500;
  win.emit("responsive");
  win.emit("responsive");
  assert.deepEqual(captured, [["hang_started", {}], ["hang_ended", { duration_ms: 3_500 }]]);
});

test("watches windows that were open before it started", () => {
  let now = 0;
  const win = new EventEmitter();
  const { captured } = setup(() => now, [win]);
  win.emit("unresponsive");
  now = 2_000;
  win.emit("responsive");
  assert.deepEqual(captured, [["hang_started", {}], ["hang_ended", { duration_ms: 2_000 }]]);
});

test("stops listening once disposed", () => {
  const { app, captured, telemetry } = setup();
  telemetry.dispose();
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 11 });
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5 });
  assert.deepEqual(captured, []);
});

test("ends a hang when its window closes or its renderer dies", () => {
  let now = 0;
  const { app, captured } = setup(() => now);
  const closing = new EventEmitter();
  const crashing = Object.assign(new EventEmitter(), { webContents: { id: 2 } });
  app.emit("browser-window-created", {}, closing);
  app.emit("browser-window-created", {}, crashing);
  closing.emit("unresponsive");
  crashing.emit("unresponsive");
  now = 1_000;
  closing.emit("closed");
  now = 3_000;
  app.emit("render-process-gone", {}, crashing.webContents, { reason: "crashed", exitCode: 11 });
  crashing.emit("responsive");
  assert.deepEqual(captured.map(([name, properties]) => [name, properties.duration_ms ?? properties.process]), [
    ["hang_started", undefined],
    ["hang_started", undefined],
    ["hang_ended", 1_000],
    ["hang_ended", 3_000],
    ["crash", "renderer"],
  ]);
});
