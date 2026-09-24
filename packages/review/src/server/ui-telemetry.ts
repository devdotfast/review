import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { mergeErrorTelemetryProperties } from "../error-telemetry";
import type {
  ReviewTabTelemetryEvent,
  ReviewTelemetryContext,
} from "../telemetry";
import {
  REVIEW_APP_SESSION_ID_HEADER,
  sanitizeUiTelemetryEvent,
} from "../ui-telemetry-events";
import { ClientErrorBudget } from "./client-error-budget";

const contextSchema = z.object({
  reviewUuid: z.string().min(1).max(128).optional(),
  presentationSessionId: z.string().min(1).max(128).optional(),
});

type SanitizedUiTelemetryEvent = NonNullable<
  ReturnType<typeof sanitizeUiTelemetryEvent>
>;

const clientErrorBudget = new ClientErrorBudget();

/**
 * Applies the per-session, per-digest error budget to a sanitized event, and
 * returns what to send in its place: the event itself, one
 * review_error_burst that says how many were withheld, or nothing. Every path
 * that reports review_client_error goes through here. Other events, and errors
 * without a session or a digest, pass unchanged.
 */
export function admitUiTelemetryEvent(
  event: SanitizedUiTelemetryEvent,
): SanitizedUiTelemetryEvent | undefined {
  if (event.event !== "review_client_error") return event;
  const sessionId = jsonString(event.properties.app_session_id);
  const messageHash = jsonString(event.properties.message_hash);

  if (sessionId === undefined || messageHash === undefined) return event;
  const admission = clientErrorBudget.admit(sessionId, messageHash);

  if (admission.verdict === "send") return event;

  if (admission.verdict === "drop") return undefined;

  return (
    sanitizeUiTelemetryEvent({
      name: "error_burst",
      properties: {
        message_hash: messageHash,
        suppressed: admission.suppressed,
        app_session_id: sessionId,
      },
    }) ?? undefined
  );
}

const MAX_CLIENT_ERROR_SESSIONS = 100;

const MAX_CLIENT_ERRORS_PER_SESSION = 20;

const clientErrorsBySession = new Map<string, string[]>();

export function recordClientError(
  event: ReturnType<typeof sanitizeUiTelemetryEvent>,
): void {
  if (event?.event !== "review_client_error") return;
  const sessionId = jsonString(event.properties.app_session_id);
  const errorName = jsonString(event.properties.error_name);

  if (sessionId === undefined || errorName === undefined) return;
  const names = clientErrorsBySession.get(sessionId) ?? [];
  names.push(errorName);

  if (names.length > MAX_CLIENT_ERRORS_PER_SESSION) names.shift();
  clientErrorsBySession.delete(sessionId);
  clientErrorsBySession.set(sessionId, names);

  while (clientErrorsBySession.size > MAX_CLIENT_ERROR_SESSIONS) {
    const oldest = clientErrorsBySession.keys().next().value;

    if (oldest === undefined) break;
    clientErrorsBySession.delete(oldest);
  }
}

export function clientErrorsForSession(sessionId: string): string[] {
  const names = clientErrorsBySession.get(sessionId) ?? [];

  if (names.length > 0) {
    clientErrorsBySession.delete(sessionId);
    clientErrorsBySession.set(sessionId, names);
  }

  return [...names];
}

export interface ReviewTelemetryCapture {
  captureTabViewed(event: ReviewTabTelemetryEvent): Promise<void>;
  captureUiEvent?(
    event: string,
    properties: Record<string, string | number | boolean>,
    context?: ReviewTelemetryContext,
  ): Promise<void>;
}

export async function captureSanitizedUiTelemetry(
  telemetry: ReviewTelemetryCapture,
  request: Request,
  name: JsonValue,
  properties: JsonValue,
  onSanitized?: (event: SanitizedUiTelemetryEvent) => void,
  /**
   * The raw error envelope, which arrives beside `properties` and never inside
   * it. This function is where the raw form dies: what continues is the class
   * name, the message with paths and secrets replaced by markers, a digest of
   * the original message, and bundle-relative frames. The allowlist re-checks
   * all of it. Never merge this into `properties`.
   */
  rawError?: JsonValue,
  /**
   * Raw review and presentation ids, beside `properties` like `error`. They
   * never reach PostHog: the telemetry API replaces them with keyed HMACs.
   */
  rawContext?: JsonValue,
): Promise<void> {
  const appSessionId =
    request.headers.get(REVIEW_APP_SESSION_ID_HEADER) ?? undefined;

  const rawProperties: JsonObject = isJsonObject(properties) ? properties : {};

  // The error fields come from the raw envelope and nowhere else; this
  // helper drops any a client tried to assert. It matters because the
  // allowlist cannot tell a cleaned message from a raw one.
  const mergedProperties = mergeErrorTelemetryProperties(
    rawProperties,
    rawError,
  );

  if (appSessionId) mergedProperties.app_session_id = appSessionId;

  const sanitized = sanitizeUiTelemetryEvent({
    name,
    properties: mergedProperties,
  });

  if (!sanitized) return;
  const admitted = admitUiTelemetryEvent(sanitized);

  if (!admitted) return;
  onSanitized?.(admitted);
  const parsedContext = contextSchema.safeParse(rawContext);
  const context = parsedContext.success ? parsedContext.data : undefined;

  try {
    await telemetry.captureUiEvent?.(
      admitted.event,
      admitted.properties,
      context,
    );
  } catch (error) {
    console.error(error);
  }
}
