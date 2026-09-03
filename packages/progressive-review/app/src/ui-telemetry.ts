import { jsonBoolean, jsonNumber, jsonString } from "@dev.fast/review-protocol";

import {
  REVIEW_APP_SESSION_ID_HEADER,
  UI_TELEMETRY_EVENTS,
} from "../../src/ui-telemetry-events";
import type { UiTelemetryEventName } from "../../src/ui-telemetry-events";
import type { ReviewSession } from "./host/review-session";

type UiTelemetryPropertyValue = string | number | boolean;
type UiTelemetryProperties = Record<string, UiTelemetryPropertyValue>;

let appOpenedSent = false;

export function reviewAppTelemetryHeaders(session: ReviewSession) {
  return { [REVIEW_APP_SESSION_ID_HEADER]: session.appSessionId };
}

export function captureAppOpened(session: ReviewSession): void {
  if (appOpenedSent) return;
  appOpenedSent = true;
  captureUiEvent(session, "app_opened");
}

export function captureUiEvent(
  session: ReviewSession,
  name: UiTelemetryEventName,
  properties?: UiTelemetryProperties,
  error?: PackedClientError,
): void {
  const sanitizedProperties = sanitizeEventProperties(name, properties);
  if (!sanitizedProperties) return;
  sanitizedProperties.app_session_id = session.appSessionId;
  const reviewFetch = session.fetch;
  try {
    void reviewFetch("/telemetry/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        properties: sanitizedProperties,
        ...(error === undefined ? {} : { error }),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Telemetry is best-effort and must never affect the review UI.
  }
}

/**
 * Report a caught error. The raw name, message, and stack travel beside the
 * allowlisted properties, not inside them, and reach only the local server on
 * this machine. The server replaces them with a message digest and with stack
 * frames rewritten to start inside the shipped bundle; nothing else leaves.
 */
export function captureClientError(
  session: ReviewSession,
  errorSource: string,
  cause: unknown,
  properties?: UiTelemetryProperties,
): void {
  captureUiEvent(
    session,
    "client_error",
    {
      error_source: errorSource,
      error_process: "canvas",
      error_name: clientErrorName(cause),
      ...properties,
    },
    cause === undefined ? undefined : packClientError(cause),
  );
}

/** The raw error envelope sent beside the event, as the server reads it. */
interface PackedClientError {
  name?: string;
  message?: string;
  stack?: string;
}

function packClientError(cause: unknown): PackedClientError {
  if (!(cause instanceof Error)) return { message: String(cause) };
  return {
    name: cause.name,
    message: cause.message,
    ...(cause.stack === undefined ? {} : { stack: cause.stack }),
  };
}

export function clientErrorName(cause: unknown): string {
  const name = cause instanceof Object ? cause.constructor?.name : undefined;
  return name !== undefined && validFreeString(name) ? name : "Error";
}

function sanitizeEventProperties(
  name: UiTelemetryEventName,
  properties: UiTelemetryProperties | undefined,
): UiTelemetryProperties | null {
  const spec = UI_TELEMETRY_EVENTS[name];
  if (!spec) return null;
  const sanitized: UiTelemetryProperties = {};
  for (const [key, propSpec] of Object.entries(spec.properties)) {
    const value = properties?.[key];
    if (value === undefined || value === null) continue;
    const text = jsonString(value);
    if (propSpec === "number") {
      const number = jsonNumber(value);
      if (number !== undefined) sanitized[key] = number;
      continue;
    }
    if (propSpec === "boolean") {
      const boolean = jsonBoolean(value);
      if (boolean !== undefined) sanitized[key] = boolean;
      continue;
    }
    if (propSpec === "enum_free_short") {
      if (text !== undefined && validFreeString(text)) sanitized[key] = text;
      continue;
    }
    if (
      Array.isArray(propSpec) &&
      text !== undefined &&
      (propSpec as readonly string[]).includes(text)
    ) {
      sanitized[key] = text;
    }
  }
  return sanitized;
}

function validFreeString(value: string): boolean {
  return (
    value.length > 0 && value.length <= 40 && /^[A-Za-z0-9_$-]+$/.test(value)
  );
}
