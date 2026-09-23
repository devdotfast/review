export * from "@dev.fast/diffr";

export * from "./structural-diff.js";

import type { JsonValue } from "@dev.fast/json";
import { z } from "zod";

export {
  parseWhiteboardCodePeekPatch,
  whiteboardCodePeekRowAnchorLine,
  whiteboardCodePeekRangeCounts,
  type WhiteboardCodePeekPatch,
  type WhiteboardCodePeekHunk,
  type WhiteboardCodePeekHunkRow,
  type WhiteboardCodePeekOrientation,
} from "./code-peek-diff.js";

import {
  type WhiteboardAgentTraceListResponse,
  WhiteboardAgentTraceListResponseSchema,
  type WhiteboardAgentTraceResponse,
  WhiteboardAgentTraceResponseSchema,
  type WhiteboardCliInstallApplyRequest,
  WhiteboardCliInstallApplyRequestSchema,
  type WhiteboardCliInstallApplyResponse,
  WhiteboardCliInstallApplyResponseSchema,
  type WhiteboardCliInstallStatus,
  WhiteboardCliInstallStatusSchema,
  type WhiteboardDesktopDiscovery,
  WhiteboardDesktopDiscoverySchema,
  type WhiteboardDesktopVerbFrame,
  WhiteboardDesktopVerbFrameSchema,
  type WhiteboardDesktopVerbResult,
  WhiteboardDesktopVerbResultSchema,
  type WhiteboardDiffFilesResponse,
  WhiteboardDiffFilesResponseSchema,
  type WhiteboardFileContentRequest,
  WhiteboardFileContentRequestSchema,
  type WhiteboardFileContentResponse,
  WhiteboardFileContentResponseSchema,
  type WhiteboardStackResponse,
  WhiteboardStackResponseSchema,
  type WhiteboardTutorialOpenResponse,
  WhiteboardTutorialOpenResponseSchema,
  type WhiteboardVerbRequest,
  WhiteboardVerbRequestSchema,
  type WhiteboardVerbResponse,
  WhiteboardVerbResponseSchema,
} from "./contracts.js";

export * from "./bug-report.js";

export * from "@dev.fast/json";

export * from "./contracts.js";

export * from "./whiteboard-api-client.js";

export {
  type ByCommitEntry,
  type WhiteboardAgentTraceEvent,
  WhiteboardAgentTraceEventSchema,
  type WhiteboardAgentTraceSession,
  WhiteboardAgentTraceSessionSchema,
  type SessionMeta,
  byCommitSchema,
  commitShaSchema,
  sessionIdSchema,
  sessionMetaSchema,
} from "@dev.fast/trace-protocol";

export function parseWhiteboardDesktopDiscovery(
  value: JsonValue,
): WhiteboardDesktopDiscovery {
  return parseZod(WhiteboardDesktopDiscoverySchema, value);
}

export function parseWhiteboardStackResponse(
  value: JsonValue,
): WhiteboardStackResponse {
  return parseZod(WhiteboardStackResponseSchema, value);
}

export function parseWhiteboardCliInstallStatus(
  value: JsonValue,
): WhiteboardCliInstallStatus {
  return parseZod(WhiteboardCliInstallStatusSchema, value);
}

export function parseWhiteboardCliInstallApplyRequest(
  value: JsonValue,
): WhiteboardCliInstallApplyRequest {
  return parseZod(WhiteboardCliInstallApplyRequestSchema, value);
}

export function parseWhiteboardCliInstallApplyResponse(
  value: JsonValue,
): WhiteboardCliInstallApplyResponse {
  return parseZod(WhiteboardCliInstallApplyResponseSchema, value);
}

export function parseWhiteboardTutorialOpenResponse(
  value: JsonValue,
): WhiteboardTutorialOpenResponse {
  return parseZod(WhiteboardTutorialOpenResponseSchema, value);
}

export function parseWhiteboardDesktopVerbFrame(
  value: JsonValue,
): WhiteboardDesktopVerbFrame {
  return parseZod(WhiteboardDesktopVerbFrameSchema, value);
}

export function parseWhiteboardDesktopVerbResult(
  value: JsonValue,
): WhiteboardDesktopVerbResult {
  return parseZod(WhiteboardDesktopVerbResultSchema, value);
}

export function parseWhiteboardDiffFilesResponse(
  value: JsonValue,
): WhiteboardDiffFilesResponse {
  return parseZod(WhiteboardDiffFilesResponseSchema, value);
}

export function parseWhiteboardFileContentResponse(
  value: JsonValue,
): WhiteboardFileContentResponse {
  return parseZod(WhiteboardFileContentResponseSchema, value);
}

export function parseWhiteboardFileContentRequest(
  value: JsonValue,
): WhiteboardFileContentRequest {
  return parseZod(WhiteboardFileContentRequestSchema, value);
}

export function parseWhiteboardVerbRequest(
  value: JsonValue,
): WhiteboardVerbRequest {
  return parseZod(WhiteboardVerbRequestSchema, value);
}

export function parseWhiteboardVerbResponse(
  value: JsonValue,
): WhiteboardVerbResponse {
  return parseZod(WhiteboardVerbResponseSchema, value);
}

export function parseWhiteboardAgentTraceListResponse(
  value: JsonValue,
): WhiteboardAgentTraceListResponse {
  return parseZod(WhiteboardAgentTraceListResponseSchema, value);
}

export function parseWhiteboardAgentTraceResponse(
  value: JsonValue,
): WhiteboardAgentTraceResponse {
  return parseZod(WhiteboardAgentTraceResponseSchema, value);
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

export { structuralRows } from "./source-alignment.js";
