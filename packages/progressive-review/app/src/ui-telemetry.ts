import {
  REVIEW_APP_SESSION_ID_HEADER,
  UI_TELEMETRY_EVENTS,
} from "../../src/ui-telemetry-events";
import type { UiTelemetryEventName } from "../../src/ui-telemetry-events";
import type { ReviewSession } from "./host/review-session";

type UiTelemetryPropertyValue = string | number | boolean;
type UiTelemetryProperties = Record<string, UiTelemetryPropertyValue>;

let appOpenedSent = false;

export function reviewAppTelemetryHeaders(
  session: ReviewSession,
): Record<string, string> {
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
  error?: unknown,
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
        ...(error === undefined ? {} : { error: packClientError(error) }),
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
  error: unknown,
  properties?: UiTelemetryProperties,
): void {
  captureUiEvent(
    session,
    "client_error",
    {
      error_source: errorSource,
      error_process: "canvas",
      error_name: clientErrorName(error),
      ...properties,
    },
    error,
  );
}

function packClientError(error: unknown): {
  name?: string;
  message?: string;
  stack?: string;
} {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
  };
}

export function clientErrorName(error: unknown): string {
  const name =
    error && typeof error === "object" ? error.constructor?.name : undefined;
  return validFreeString(name) ? name : "Error";
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
    if (propSpec === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        sanitized[key] = value;
      }
      continue;
    }
    if (propSpec === "boolean") {
      if (typeof value === "boolean") sanitized[key] = value;
      continue;
    }
    if (propSpec === "enum_free_short") {
      if (typeof value === "string" && validFreeString(value)) {
        sanitized[key] = value;
      }
      continue;
    }
    if (
      Array.isArray(propSpec) &&
      typeof value === "string" &&
      (propSpec as readonly string[]).includes(value)
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function validFreeString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[A-Za-z0-9_$-]+$/.test(value)
  );
}
