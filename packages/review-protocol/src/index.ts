import { z } from "zod";

import {
  type ReviewAgentTraceListResponse,
  ReviewAgentTraceListResponseSchema,
  type ReviewAgentTraceResponse,
  ReviewAgentTraceResponseSchema,
  type ReviewCliInstallApplyRequest,
  ReviewCliInstallApplyRequestSchema,
  type ReviewCliInstallApplyResponse,
  ReviewCliInstallApplyResponseSchema,
  type ReviewCliInstallStatus,
  ReviewCliInstallStatusSchema,
  type ReviewDesktopDiscovery,
  ReviewDesktopDiscoverySchema,
  type ReviewDesktopGlobalEvent,
  ReviewDesktopGlobalEventSchema,
  type ReviewDesktopVerbFrame,
  ReviewDesktopVerbFrameSchema,
  type ReviewDesktopVerbResult,
  ReviewDesktopVerbResultSchema,
  type ReviewDiffFilesResponse,
  ReviewDiffFilesResponseSchema,
  type ReviewFileContentRequest,
  ReviewFileContentRequestSchema,
  type ReviewFileContentResponse,
  ReviewFileContentResponseSchema,
  type ReviewListResponse,
  ReviewListResponseSchema,
  type ReviewOpenResponse,
  ReviewOpenResponseSchema,
  type ReviewPublishReadyRequest,
  ReviewPublishReadyRequestSchema,
  type ReviewSessionResponse,
  ReviewSessionResponseSchema,
  type ReviewStackResponse,
  ReviewStackResponseSchema,
  type ReviewTutorialOpenResponse,
  ReviewTutorialOpenResponseSchema,
  type ReviewVerbRequest,
  ReviewVerbRequestSchema,
  type ReviewVerbResponse,
  ReviewVerbResponseSchema,
} from "./contracts.js";
import type { JsonValue } from "./json.js";

export * from "./bug-report.js";
export * from "./json.js";
export * from "./runtime-value.js";
export * from "./contracts.js";

export function parseReviewDesktopDiscovery(
  value: JsonValue,
): ReviewDesktopDiscovery {
  return parseZod(ReviewDesktopDiscoverySchema, value);
}

export function parseReviewListResponse(value: JsonValue): ReviewListResponse {
  return parseZod(ReviewListResponseSchema, value);
}

export function parseReviewStackResponse(
  value: JsonValue,
): ReviewStackResponse {
  return parseZod(ReviewStackResponseSchema, value);
}

export function parseReviewCliInstallStatus(
  value: JsonValue,
): ReviewCliInstallStatus {
  return parseZod(ReviewCliInstallStatusSchema, value);
}

export function parseReviewCliInstallApplyRequest(
  value: JsonValue,
): ReviewCliInstallApplyRequest {
  return parseZod(ReviewCliInstallApplyRequestSchema, value);
}

export function parseReviewCliInstallApplyResponse(
  value: JsonValue,
): ReviewCliInstallApplyResponse {
  return parseZod(ReviewCliInstallApplyResponseSchema, value);
}

export function parseReviewPublishReadyRequest(
  value: JsonValue,
): ReviewPublishReadyRequest {
  return parseZod(ReviewPublishReadyRequestSchema, value);
}

export function parseReviewOpenResponse(value: JsonValue): ReviewOpenResponse {
  return parseZod(ReviewOpenResponseSchema, value);
}

export function parseReviewTutorialOpenResponse(
  value: JsonValue,
): ReviewTutorialOpenResponse {
  return parseZod(ReviewTutorialOpenResponseSchema, value);
}

export function parseReviewDesktopGlobalEvent(
  value: JsonValue,
): ReviewDesktopGlobalEvent {
  return parseZod(ReviewDesktopGlobalEventSchema, value);
}

export function parseReviewDesktopVerbFrame(
  value: JsonValue,
): ReviewDesktopVerbFrame {
  return parseZod(ReviewDesktopVerbFrameSchema, value);
}

export function parseReviewDesktopVerbResult(
  value: JsonValue,
): ReviewDesktopVerbResult {
  return parseZod(ReviewDesktopVerbResultSchema, value);
}

export function parseReviewSessionResponse(
  value: JsonValue,
): ReviewSessionResponse {
  return parseZod(ReviewSessionResponseSchema, value);
}

export function parseReviewDiffFilesResponse(
  value: JsonValue,
): ReviewDiffFilesResponse {
  return parseZod(ReviewDiffFilesResponseSchema, value);
}

export function parseReviewFileContentResponse(
  value: JsonValue,
): ReviewFileContentResponse {
  return parseZod(ReviewFileContentResponseSchema, value);
}

export function parseReviewFileContentRequest(
  value: JsonValue,
): ReviewFileContentRequest {
  return parseZod(ReviewFileContentRequestSchema, value);
}

export function parseReviewVerbRequest(value: JsonValue): ReviewVerbRequest {
  return parseZod(ReviewVerbRequestSchema, value);
}

export function parseReviewVerbResponse(value: JsonValue): ReviewVerbResponse {
  return parseZod(ReviewVerbResponseSchema, value);
}

export function parseReviewAgentTraceListResponse(
  value: JsonValue,
): ReviewAgentTraceListResponse {
  return parseZod(ReviewAgentTraceListResponseSchema, value);
}

export function parseReviewAgentTraceResponse(
  value: JsonValue,
): ReviewAgentTraceResponse {
  return parseZod(ReviewAgentTraceResponseSchema, value);
}

export function parseZod<T>(
  schema: z.ZodType<T>,
  value: JsonValue,
  label?: string,
  prefixPath = false,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const issuePath = formatIssuePath(issue?.path ?? []);
  const path =
    prefixPath && label
      ? issuePath
        ? `${label}.${issuePath}`
        : label
      : issuePath || label;
  throw new Error(
    `${path ? `${path} ` : ""}${issue?.message ?? "Invalid input"}`,
  );
}

function formatIssuePath(path: PropertyKey[]): string {
  let output = "";
  for (const segment of path) {
    if (Number.isInteger(segment)) {
      output += `[${String(segment)}]`;
    } else {
      output += `${output ? "." : ""}${String(segment)}`;
    }
  }
  return output;
}
