import type { IncomingMessage } from "node:http";

import {
  ReviewBugReportRequestSchema,
  ReviewDiffFilesRequestSchema,
  ReviewThreadsCommandSchema,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { CreateReviewCommentInputSchema } from "../review-comment-schema";
import type { ReviewTabTelemetryEvent } from "../telemetry";
import { ThreadTargetSchema } from "../thread-target-schema";
import type {
  CreateReviewCommentInput,
  CreateReviewSubmissionInput,
  ThreadTarget,
  UpdateReviewCommentInput,
} from "../types";
import { HttpJsonError, readBoundedJson } from "./http-json";
const MIN_REVIEW_TAB_DWELL_MS = 250;
const MAX_REVIEW_TAB_DWELL_MS = 4 * 60 * 60 * 1_000;
const APP_SESSION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{15,127}$/;
const MAX_BUG_REPORT_DESCRIPTION_BYTES = 64 * 1024;
const MAX_BUG_REPORT_SCREENSHOT_BYTES = 3 * 1024 * 1024;

const nonEmptyStringSchema = z
  .string({ error: "must be a non-empty string" })
  .min(1, "must be a non-empty string");
const positiveIntegerSchema = z.coerce
  .number({ error: "must be a positive integer" })
  .int("must be a positive integer")
  .positive("must be a positive integer");

const softwareMapLineRangeShape = {
  fromLine: positiveIntegerSchema,
  toLine: positiveIntegerSchema,
};

function validateSoftwareMapLineRange(
  range: { fromLine: number; toLine: number },
  context: z.core.$RefinementCtx,
) {
  if (range.toLine < range.fromLine) {
    context.addIssue({
      code: "custom",
      message: "toLine must be at least fromLine",
      path: ["toLine"],
    });
  }
}

export const SoftwareMapLineRangeInputSchema = z
  .strictObject(softwareMapLineRangeShape)
  .superRefine(validateSoftwareMapLineRange);

export function parseReviewBugReportInput(value: unknown) {
  const parsed = ReviewBugReportRequestSchema.parse(value);
  if (
    Buffer.byteLength(parsed.description, "utf8") >
    MAX_BUG_REPORT_DESCRIPTION_BYTES
  ) {
    throw new HttpJsonError(
      `description must not exceed ${MAX_BUG_REPORT_DESCRIPTION_BYTES} UTF-8 bytes`,
      413,
    );
  }
  if (parsed.screenshot) {
    const screenshot = Buffer.from(parsed.screenshot.base64, "base64");
    if (screenshot.toString("base64") !== parsed.screenshot.base64) {
      throw new HttpJsonError("screenshot.base64 must be valid base64", 400);
    }
    if (screenshot.byteLength > MAX_BUG_REPORT_SCREENSHOT_BYTES) {
      throw new HttpJsonError(
        `screenshot must not exceed ${MAX_BUG_REPORT_SCREENSHOT_BYTES} decoded bytes`,
        413,
      );
    }
  }
  return parsed;
}
export const SoftwareMapSourceRangeInputSchema = z
  .strictObject({
    file: nonEmptyStringSchema,
    ...softwareMapLineRangeShape,
  })
  .superRefine(validateSoftwareMapLineRange);

const optionalLineRangesSchema = z
  .array(SoftwareMapLineRangeInputSchema)
  .optional();

export const CodePeekRootInputSchema = z
  .strictObject({
    kind: z.literal("range"),
    file: nonEmptyStringSchema,
    fromLine: positiveIntegerSchema,
    toLine: positiveIntegerSchema,
  })
  .superRefine((range, context) => {
    if (range.toLine < range.fromLine) {
      context.addIssue({
        code: "custom",
        message: "must be at least fromLine",
        path: ["toLine"],
      });
    }
  });

export const SoftwareMapCodeElementInputSchema = z.strictObject({
  path: nonEmptyStringSchema,
  label: nonEmptyStringSchema.optional(),
  description: nonEmptyStringSchema.optional(),
  changeStatus: z
    .enum(["added", "removed", "modified", "unchanged"])
    .optional()
    .catch(undefined),
  sourceRanges: z.array(SoftwareMapSourceRangeInputSchema).optional(),
});

const SoftwareMapCoverageFileInputSchema = z.strictObject({
  path: nonEmptyStringSchema,
  ranges: optionalLineRangesSchema,
});

export const SoftwareMapCoverageClaimInputSchema = z.strictObject({
  path: nonEmptyStringSchema,
  files: z.array(SoftwareMapCoverageFileInputSchema).default([]),
  globs: z.array(z.string()).optional(),
});

export const ReviewSubmissionInputSchema = z.strictObject({
  submissionId: nonEmptyStringSchema,
  decision: z.enum(["approve", "request-changes"]),
  comments: z.array(CreateReviewCommentInputSchema),
});

export const ReviewTabTelemetryInputSchema = z
  .strictObject({
    tab: z.enum(["review", "commits", "map", "files", "trace"], {
      error: "must be review, commits, map, files, or trace",
    }),
    reason: z.enum(["tab_change", "visibility_hidden", "pagehide", "unmount"], {
      error: "must be tab_change, visibility_hidden, pagehide, or unmount",
    }),
    duration_ms: z
      .number()
      .int("must be an integer from 250ms to 4h")
      .min(MIN_REVIEW_TAB_DWELL_MS, "must be an integer from 250ms to 4h")
      .max(MAX_REVIEW_TAB_DWELL_MS, "must be an integer from 250ms to 4h"),
    app_session_id: z
      .string()
      .regex(APP_SESSION_ID_PATTERN, "must be a valid session id"),
    document: z.unknown().optional(),
  })
  .transform((event) => ({
    tab: event.tab,
    reason: event.reason,
    durationMs: event.duration_ms,
    appSessionId: event.app_session_id,
  }));

export const UpdateReviewCommentInputSchema = z.strictObject({
  status: z
    .enum(["open", "resolved"], {
      error: "status must be open or resolved",
    })
    .optional(),
  body: z.string({ error: "body must be a string" }).optional(),
  messageId: nonEmptyStringSchema.optional(),
});

export function readJson(req: IncomingMessage): Promise<unknown> {
  return readBoundedJson(req, undefined, {});
}

export function requestJsonErrorStatus(error: unknown): number {
  return error instanceof HttpJsonError ? error.statusCode : 400;
}

export function parseCodePeekRoot(value: unknown) {
  return parseZod(CodePeekRootInputSchema, value, "CodePeek root");
}

export function parseSoftwareMapCodeElements(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("SoftwareMap codeElements must be an array");
  }
  return parseZod(
    z.array(SoftwareMapCodeElementInputSchema),
    value,
    "SoftwareMap codeElements",
  );
}

export function parseSoftwareMapCoverageClaims(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("SoftwareMap coverageClaims must be an array");
  }
  return parseZod(
    z.array(SoftwareMapCoverageClaimInputSchema),
    value,
    "SoftwareMap coverageClaims",
  );
}

export function parseReviewSubmissionInput(
  value: unknown,
): CreateReviewSubmissionInput {
  return parseZod(ReviewSubmissionInputSchema, value, "Review submission");
}

export function parseReviewTabTelemetryInput(
  value: unknown,
): ReviewTabTelemetryEvent {
  return parseZod(
    ReviewTabTelemetryInputSchema,
    value,
    "Review tab telemetry event",
  );
}

export function parseReviewDiffFilesInput(value: unknown) {
  const input = parseZod(ReviewDiffFilesRequestSchema, value);
  return {
    includePatch: input.includePatch !== false,
    paths: input.paths,
    commit: input.commit,
  };
}

export function parseReviewCommentInput(
  value: unknown,
): CreateReviewCommentInput {
  return parseZod(CreateReviewCommentInputSchema, value, "Review comment");
}

export function parseReviewThreadsCommand(value: unknown) {
  return parseZod(ReviewThreadsCommandSchema, value, "Review thread command");
}

export function parseUpdateReviewCommentInput(
  value: unknown,
): UpdateReviewCommentInput {
  return parseZod(UpdateReviewCommentInputSchema, value, "Comment update");
}

export function parseReviewCommentMessagePath(
  pathname: string,
): { threadId: string; messageId: string } | null {
  const match = pathname.match(
    /^\/__progressive-review\/comments\/([^/]+)\/messages\/([^/]+)$/,
  );
  if (!match) return null;
  return {
    threadId: decodeURIComponent(match[1]),
    messageId: decodeURIComponent(match[2]),
  };
}

export function parseThreadTarget(value: unknown, label: string): ThreadTarget {
  return parseZod(ThreadTargetSchema, value, label, true);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function parseZod<T>(
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
