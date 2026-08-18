import { z } from "zod";

import {
  type ReviewAgentTraceEvent,
  ReviewAgentTraceEventSchema,
  type ReviewAgentTraceListResponse,
  ReviewAgentTraceListResponseSchema,
  type ReviewAgentTraceResponse,
  ReviewAgentTraceResponseSchema,
  type ReviewAgentTraceSession,
  ReviewAgentTraceSessionSchema,
  type ReviewCliInstallApplyRequest,
  ReviewCliInstallApplyRequestSchema,
  type ReviewCliInstallApplyResponse,
  ReviewCliInstallApplyResponseSchema,
  type ReviewCliInstallStatus,
  ReviewCliInstallStatusSchema,
  type ReviewDescriptor,
  ReviewDescriptorSchema,
  type ReviewDesktopDiscovery,
  ReviewDesktopDiscoverySchema,
  type ReviewDesktopGlobalEvent,
  ReviewDesktopGlobalEventSchema,
  type ReviewDesktopState,
  ReviewDesktopStateSchema,
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
  ReviewRangeSchema,
  type ReviewRangeWire,
  type ReviewRecord,
  ReviewRecordSchema,
  type ReviewRepositoryIdentity,
  ReviewRepositoryIdentitySchema,
  type ReviewRuntimeConfig,
  ReviewRuntimeConfigSchema,
  type ReviewServerEvent,
  ReviewServerEventSchema,
  type ReviewSessionDescriptor,
  ReviewSessionDescriptorSchema,
  type ReviewSessionLifecycleEvent,
  ReviewSessionLifecycleEventSchema,
  type ReviewSessionMutationResponse,
  ReviewSessionMutationResponseSchema,
  type ReviewSessionResponse,
  ReviewSessionResponseSchema,
  ReviewSessionSchema,
  type ReviewSessionWire,
  ReviewSubmissionResponseSchema,
  ReviewSubmissionWireSchema,
  type ReviewSurfaceEvent,
  ReviewSurfaceEventSchema,
  type ReviewThreadAnchorsResponse,
  ReviewThreadAnchorsResponseSchema,
  type ReviewTutorialOpenResponse,
  ReviewTutorialOpenResponseSchema,
  type ReviewVerbRequest,
  ReviewVerbRequestSchema,
  type ReviewVerbResponse,
  ReviewVerbResponseSchema,
} from "./contracts.js";

export * from "./bug-report.js";
export * from "./contracts.js";

export function parseReviewRuntimeConfig(value: unknown): ReviewRuntimeConfig {
  return parseContract(ReviewRuntimeConfigSchema, value);
}

export function parseReviewDesktopDiscovery(
  value: unknown,
): ReviewDesktopDiscovery {
  return parseContract(ReviewDesktopDiscoverySchema, value);
}

export function parseReviewRepositoryIdentity(
  value: unknown,
): ReviewRepositoryIdentity {
  return parseContract(ReviewRepositoryIdentitySchema, value);
}

export function parseReviewSessionDescriptor(
  value: unknown,
): ReviewSessionDescriptor {
  return parseContract(ReviewSessionDescriptorSchema, value);
}

export function parseReviewDescriptor(value: unknown): ReviewDescriptor {
  return parseContract(ReviewDescriptorSchema, value);
}

export function parseReviewListResponse(value: unknown): ReviewListResponse {
  return parseContract(ReviewListResponseSchema, value);
}

export function parseReviewCliInstallStatus(
  value: unknown,
): ReviewCliInstallStatus {
  return parseContract(ReviewCliInstallStatusSchema, value);
}

export function parseReviewCliInstallApplyRequest(
  value: unknown,
): ReviewCliInstallApplyRequest {
  return parseContract(ReviewCliInstallApplyRequestSchema, value);
}

export function parseReviewCliInstallApplyResponse(
  value: unknown,
): ReviewCliInstallApplyResponse {
  return parseContract(ReviewCliInstallApplyResponseSchema, value);
}

export function parseReviewPublishReadyRequest(
  value: unknown,
): ReviewPublishReadyRequest {
  return parseContract(ReviewPublishReadyRequestSchema, value);
}

export function parseReviewRecord(value: unknown): ReviewRecord {
  return parseContract(ReviewRecordSchema, value);
}

export function parseReviewOpenResponse(value: unknown): ReviewOpenResponse {
  return parseContract(ReviewOpenResponseSchema, value);
}

export function parseReviewTutorialOpenResponse(
  value: unknown,
): ReviewTutorialOpenResponse {
  return parseContract(ReviewTutorialOpenResponseSchema, value);
}

export function parseReviewSessionMutationResponse(
  value: unknown,
): ReviewSessionMutationResponse {
  return parseContract(ReviewSessionMutationResponseSchema, value);
}

export function parseReviewSessionLifecycleEvent(
  value: unknown,
): ReviewSessionLifecycleEvent {
  return parseContract(ReviewSessionLifecycleEventSchema, value);
}

export function parseReviewDesktopGlobalEvent(
  value: unknown,
): ReviewDesktopGlobalEvent {
  return parseContract(ReviewDesktopGlobalEventSchema, value);
}

export function parseReviewDesktopVerbFrame(
  value: unknown,
): ReviewDesktopVerbFrame {
  return parseContract(ReviewDesktopVerbFrameSchema, value);
}

export function parseReviewDesktopVerbResult(
  value: unknown,
): ReviewDesktopVerbResult {
  return parseContract(ReviewDesktopVerbResultSchema, value);
}

export function parseReviewSession(value: unknown): ReviewSessionWire {
  return parseContract(ReviewSessionSchema, value);
}

export function parseReviewSessionResponse(
  value: unknown,
): ReviewSessionResponse {
  return parseContract(ReviewSessionResponseSchema, value);
}

export function parseReviewDiffFilesResponse(
  value: unknown,
): ReviewDiffFilesResponse {
  return parseContract(ReviewDiffFilesResponseSchema, value);
}

export function parseReviewFileContentResponse(
  value: unknown,
): ReviewFileContentResponse {
  return parseContract(ReviewFileContentResponseSchema, value);
}

export function parseReviewFileContentRequest(
  value: unknown,
): ReviewFileContentRequest {
  return parseContract(ReviewFileContentRequestSchema, value);
}

export function parseReviewThreadAnchorsResponse(
  value: unknown,
): ReviewThreadAnchorsResponse {
  return parseContract(ReviewThreadAnchorsResponseSchema, value);
}

export function parseReviewServerEvent(value: unknown): ReviewServerEvent {
  return parseContract(ReviewServerEventSchema, value);
}

export function parseReviewVerbRequest(value: unknown): ReviewVerbRequest {
  return parseContract(ReviewVerbRequestSchema, value);
}

export function parseReviewVerbResponse(value: unknown): ReviewVerbResponse {
  return parseContract(ReviewVerbResponseSchema, value);
}

export function parseReviewSurfaceEvent(value: unknown): ReviewSurfaceEvent {
  return parseContract(ReviewSurfaceEventSchema, value);
}

export function parseReviewDesktopState(value: unknown): ReviewDesktopState {
  return parseContract(ReviewDesktopStateSchema, value);
}

export function parseReviewRange(value: unknown): ReviewRangeWire {
  return parseContract(ReviewRangeSchema, value);
}

export function parseReviewAgentTraceEvent(
  value: unknown,
): ReviewAgentTraceEvent {
  return parseContract(ReviewAgentTraceEventSchema, value);
}

export function parseReviewAgentTraceSession(
  value: unknown,
): ReviewAgentTraceSession {
  return parseContract(ReviewAgentTraceSessionSchema, value);
}

export function parseReviewAgentTraceListResponse(
  value: unknown,
): ReviewAgentTraceListResponse {
  return parseContract(ReviewAgentTraceListResponseSchema, value);
}

export function parseReviewAgentTraceResponse(
  value: unknown,
): ReviewAgentTraceResponse {
  return parseContract(ReviewAgentTraceResponseSchema, value);
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const label = issue?.path.map(String).join(".");
  throw new Error(
    `${label ? `${label} ` : ""}${issue?.message ?? "Invalid input"}`,
  );
}
