import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  drainServerCrashReport,
  installProcessErrorTelemetry,
} from "./process-error-telemetry";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "server-errors-"));
  roots.push(root);

  const captured: Array<[string, Record<string, string | number | boolean>]> =
    [];

  const telemetry = {
    captureUiEvent: async (
      event: string,
      properties: Record<string, string | number | boolean>,
    ) => {
      captured.push([event, properties]);
    },
  };

  return {
    captured,
    telemetry,
    process: new EventEmitter(),
    crashReportPath: path.join(root, "telemetry", "server-crash.json"),
  };
}

function bundleError(message: string): TypeError {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at f (/app/out/review-runtime/server.js:2:3)`;

  return error;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("installProcessErrorTelemetry", () => {
  it("leaves a fatal error on disk for the next start to send", async () => {
    const { captured, telemetry, process, crashReportPath } = await harness();

    installProcessErrorTelemetry(telemetry, {
      process,
      appSessionId: "session-fatal-0001",
      crashReportPath,
    });
    // No uncaughtException listener: Node exits after the monitor returns, so
    // nothing asynchronous would complete.
    process.emit("uncaughtExceptionMonitor", bundleError("boom"), "uncaught");
    await settle();

    expect(captured).toEqual([]);
    expect(existsSync(crashReportPath)).toBe(true);

    await drainServerCrashReport(telemetry, crashReportPath);
    await drainServerCrashReport(telemetry, crashReportPath);

    expect(captured).toHaveLength(1);
    expect(captured[0][0]).toBe("review_client_error");
    expect(captured[0][1]).toMatchObject({
      error_source: "server_unexpected",
      error_process: "server",
      error_name: "TypeError",
      app_session_id: "session-fatal-0001",
      frames: "review-runtime/server.js:2:3",
    });
    expect(existsSync(crashReportPath)).toBe(false);
  });

  it("sends survivable errors at once, through the per-session budget", async () => {
    const { captured, telemetry, process, crashReportPath } = await harness();
    // The Desktop utility process's bootstrap handles both, so neither exits.
    process.on("uncaughtException", () => undefined);
    process.on("unhandledRejection", () => undefined);

    const stop = installProcessErrorTelemetry(telemetry, {
      process,
      appSessionId: "session-survive-01",
      crashReportPath,
    });

    for (let i = 0; i < 4; i++)
      process.emit("unhandledRejection", bundleError("loop"));

    for (let i = 0; i < 3; i++)
      process.emit("uncaughtExceptionMonitor", bundleError("loop"), "uncaught");

    await settle();

    expect(captured.map(([event]) => event)).toEqual([
      ...Array(5).fill("review_client_error"),
      "review_error_burst",
    ]);
    expect(existsSync(crashReportPath)).toBe(false);

    stop();
    process.emit("unhandledRejection", bundleError("after stop"));
    await settle();
    expect(captured).toHaveLength(6);
  });

  it("does not observe rejections nobody handles, so Node still throws them", async () => {
    const { telemetry, process, crashReportPath } = await harness();

    installProcessErrorTelemetry(telemetry, { process, crashReportPath });

    expect(process.listenerCount("unhandledRejection")).toBe(0);
  });
});
