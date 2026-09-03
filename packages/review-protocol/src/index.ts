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
  type ReviewTutorialOpenResponse,
  ReviewTutorialOpenResponseSchema,
  type ReviewVerbRequest,
  ReviewVerbRequestSchema,
  type ReviewVerbResponse,
  ReviewVerbResponseSchema,
} from "./contracts.js";

export * from "./bug-report.js";
export * from "./contracts.js";

export function parseReviewDesktopDiscovery(
  value: unknown,
): ReviewDesktopDiscovery {
  return parseZod(ReviewDesktopDiscoverySchema, value);
}

export function parseReviewListResponse(value: unknown): ReviewListResponse {
  return parseZod(ReviewListResponseSchema, value);
}

export function parseReviewCliInstallStatus(
  value: unknown,
): ReviewCliInstallStatus {
  return parseZod(ReviewCliInstallStatusSchema, value);
}

export function parseReviewCliInstallApplyRequest(
  value: unknown,
): ReviewCliInstallApplyRequest {
  return parseZod(ReviewCliInstallApplyRequestSchema, value);
}

export function parseReviewCliInstallApplyResponse(
  value: unknown,
): ReviewCliInstallApplyResponse {
  return parseZod(ReviewCliInstallApplyResponseSchema, value);
}

export function parseReviewPublishReadyRequest(
  value: unknown,
): ReviewPublishReadyRequest {
  return parseZod(ReviewPublishReadyRequestSchema, value);
}

export function parseReviewOpenResponse(value: unknown): ReviewOpenResponse {
  return parseZod(ReviewOpenResponseSchema, value);
}

export function parseReviewTutorialOpenResponse(
  value: unknown,
): ReviewTutorialOpenResponse {
  return parseZod(ReviewTutorialOpenResponseSchema, value);
}

export function parseReviewDesktopGlobalEvent(
  value: unknown,
): ReviewDesktopGlobalEvent {
  return parseZod(ReviewDesktopGlobalEventSchema, value);
}

export function parseReviewDesktopVerbFrame(
  value: unknown,
): ReviewDesktopVerbFrame {
  return parseZod(ReviewDesktopVerbFrameSchema, value);
}

export function parseReviewDesktopVerbResult(
  value: unknown,
): ReviewDesktopVerbResult {
  return parseZod(ReviewDesktopVerbResultSchema, value);
}

export function parseReviewSessionResponse(
  value: unknown,
): ReviewSessionResponse {
  return parseZod(ReviewSessionResponseSchema, value);
}

export function parseReviewDiffFilesResponse(
  value: unknown,
): ReviewDiffFilesResponse {
  return parseZod(ReviewDiffFilesResponseSchema, value);
}

export function parseReviewFileContentResponse(
  value: unknown,
): ReviewFileContentResponse {
  return parseZod(ReviewFileContentResponseSchema, value);
}

export function parseReviewFileContentRequest(
  value: unknown,
): ReviewFileContentRequest {
  return parseZod(ReviewFileContentRequestSchema, value);
}

export function parseReviewVerbRequest(value: unknown): ReviewVerbRequest {
  return parseZod(ReviewVerbRequestSchema, value);
}

export function parseReviewVerbResponse(value: unknown): ReviewVerbResponse {
  return parseZod(ReviewVerbResponseSchema, value);
}

export function parseReviewAgentTraceListResponse(
  value: unknown,
): ReviewAgentTraceListResponse {
  return parseZod(ReviewAgentTraceListResponseSchema, value);
}

export function parseReviewAgentTraceResponse(
  value: unknown,
): ReviewAgentTraceResponse {
  return parseZod(ReviewAgentTraceResponseSchema, value);
}

export function parseZod<T>(
  schema: z.ZodType<T>,
  value: unknown,
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
    if (typeof segment === "number") {
      output += `[${segment}]`;
    } else {
      output += `${output ? "." : ""}${String(segment)}`;
    }
  }
  return output;
}
