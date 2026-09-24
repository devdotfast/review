// Reports the server process's own uncaught errors as review_client_error,
// through the same cleaner, allowlist and per-session budget as every other
// client error.
//
// Whether an uncaught error is fatal depends on the host. The Desktop utility
// process runs behind VS Code's bootstrap-fork, which installs uncaughtException
// and unhandledRejection handlers that log and keep the process up. Headless
// runs as plain Node, where both exit. This module never adds a handler that
// would change that: it observes through uncaughtExceptionMonitor, and watches
// rejections only when something already handles them.
//
// A fatal error exits before any network send can finish, so it is written to a
// file synchronously and sent by the next server start.

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { mergeErrorTelemetryProperties } from "../error-telemetry";
import { devReviewHome } from "../review-home-paths";
import { sanitizeUiTelemetryEvent } from "../ui-telemetry-events";
import {
  type ReviewTelemetryCapture,
  admitUiTelemetryEvent,
} from "./ui-telemetry";

type ErrorTelemetry = Pick<ReviewTelemetryCapture, "captureUiEvent">;

/** The slice of `process` this module uses; tests pass an EventEmitter. */
type ProcessErrorEvents = Pick<
  NodeJS.EventEmitter,
  "on" | "off" | "listenerCount"
>;

export function serverCrashReportPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(devReviewHome(env), "telemetry", "server-crash.json");
}

export function installProcessErrorTelemetry(
  telemetry: ErrorTelemetry,
  options: {
    process?: ProcessErrorEvents;
    appSessionId?: string;
    crashReportPath?: string;
  } = {},
): () => void {
  const target = options.process ?? process;
  const crashReportPath = options.crashReportPath ?? serverCrashReportPath();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- process event boundary
  const onUncaught = (cause: unknown) => {
    const properties = serverErrorProperties(
      toError(cause),
      options.appSessionId,
    );

    // With no uncaughtException handler Node exits once the monitors return.
    if (target.listenerCount("uncaughtException") === 0)
      writeCrashReport(crashReportPath, properties);
    else void sendServerError(telemetry, properties);
  };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- process event boundary
  const onRejection = (cause: unknown) => {
    void sendServerError(
      telemetry,
      serverErrorProperties(toError(cause), options.appSessionId),
    );
  };

  // A first unhandledRejection listener would stop Node from throwing
  // unhandled rejections. Without one they arrive at the monitor instead.
  const watchRejections = target.listenerCount("unhandledRejection") > 0;

  target.on("uncaughtExceptionMonitor", onUncaught);

  if (watchRejections) target.on("unhandledRejection", onRejection);

  return () => {
    target.off("uncaughtExceptionMonitor", onUncaught);

    if (watchRejections) target.off("unhandledRejection", onRejection);
  };
}

/** Sends, once, the fatal error an earlier server process left behind. */
export async function drainServerCrashReport(
  telemetry: ErrorTelemetry,
  crashReportPath: string = serverCrashReportPath(),
): Promise<void> {
  let properties: JsonValue;

  try {
    const text = await readFile(crashReportPath, "utf8");
    await rm(crashReportPath, { force: true });
    properties = parseJsonText(text);
  } catch {
    return;
  }

  await sendServerError(telemetry, properties);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- process event boundary
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function serverErrorProperties(error: Error, appSessionId?: string) {
  const properties: JsonObject = {
    error_source: "server_unexpected",
    error_process: "server",
    error_name: error.name,
  };

  if (appSessionId) properties.app_session_id = appSessionId;

  return mergeErrorTelemetryProperties(properties, {
    name: error.name,
    message: error.message,
    stack: error.stack ?? "",
  });
}

function writeCrashReport(
  crashReportPath: string,
  properties: JsonObject,
): void {
  // Only what the allowlist accepts is written, so the file holds nothing
  // that could not have been sent.
  const sanitized = sanitizeUiTelemetryEvent({
    name: "client_error",
    properties,
  });

  if (!sanitized) return;

  try {
    mkdirSync(path.dirname(crashReportPath), { recursive: true });
    writeFileSync(crashReportPath, JSON.stringify(sanitized.properties), {
      mode: 0o600,
    });
  } catch {
    // The process is exiting; there is nowhere left to report this.
  }
}

async function sendServerError(
  telemetry: ErrorTelemetry,
  properties: JsonValue,
): Promise<void> {
  const sanitized = sanitizeUiTelemetryEvent({
    name: "client_error",
    properties,
  });

  const admitted = sanitized ? admitUiTelemetryEvent(sanitized) : undefined;

  if (!admitted) return;

  try {
    await telemetry.captureUiEvent?.(admitted.event, admitted.properties);
  } catch {
    // Telemetry must never add a second error to the one being reported.
  }
}
