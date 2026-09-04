import { z } from "zod";

import type { JsonValue } from "./json.js";

const requiredString = z
  .string({ error: "must be a string" })
  .refine((value) => value.trim().length > 0, "must be a string");

export const ReviewBugReportRequestSchema = z.strictObject({
  description: z.string(),
  include_review: z.boolean(),
  include_map: z.boolean(),
  include_diff: z.boolean(),
  include_trace: z.boolean().default(false),
  screenshot: z
    .strictObject({
      mime: z.literal("image/jpeg"),
      base64: z.string(),
    })
    .optional(),
  app_session_id: requiredString
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
  app_version: requiredString.max(100),
});
export type ReviewBugReportRequest = z.infer<
  typeof ReviewBugReportRequestSchema
>;

const compressedPartBytes = z.number().int().positive().max(100_000_000);
const compressedSha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ReviewBugReportPartSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.literal("payload"),
    filename: z.literal("payload.json.gz"),
    bytes: compressedPartBytes,
    sha256: compressedSha256,
  }),
  z.strictObject({
    field: z.literal("trace"),
    filename: z.string().regex(/^trace-(0|[1-9]\d?)\.jsonl\.gz$/),
    bytes: compressedPartBytes,
    sha256: compressedSha256,
    session_id: requiredString.max(128),
  }),
]);
export type ReviewBugReportPart = z.infer<typeof ReviewBugReportPartSchema>;

export const ReviewBugReportMetaV2Schema = z
  .strictObject({
    schema_version: z.literal(2),
    description_length: z.number().int().nonnegative().max(65_536),
    description: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 65_536,
        "must not exceed 65,536 UTF-8 bytes",
      )
      .optional(),
    has_review: z.boolean(),
    has_map: z.boolean(),
    has_diff: z.boolean(),
    has_screenshot: z.boolean(),
    has_trace: z.boolean(),
    trace_harness: z.enum(["claude-code", "codex", "pi"]).optional(),
    payload_bytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    app_version: requiredString.max(100),
    cli_version: requiredString.max(100),
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ]),
    truncated_diff: z.boolean(),
    truncated_map: z.boolean(),
    truncated_screenshot: z.boolean(),
    truncated_trace: z.boolean(),
    parts: z.array(ReviewBugReportPartSchema).min(1).max(34),
  })
  .superRefine((meta, context) => {
    if (
      meta.description !== undefined &&
      new TextEncoder().encode(meta.description).byteLength !==
        meta.description_length
    ) {
      context.addIssue({
        code: "custom",
        path: ["description_length"],
        message: "must match the description UTF-8 byte length",
      });
    }
    const [first, ...traces] = meta.parts;
    const validOrder =
      first?.field === "payload" &&
      traces.every(
        (part, index) =>
          part.field === "trace" && part.filename === `trace-${index}.jsonl.gz`,
      );
    const sessionIds = traces.map((part) =>
      part.field === "trace" ? part.session_id : "",
    );
    if (!validOrder || new Set(sessionIds).size !== sessionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "must list the payload then trace-<n> parts in order",
      });
    }
    if (meta.has_trace !== traces.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["has_trace"],
        message: "must match the presence of trace parts",
      });
    }
    if (meta.has_trace !== (meta.trace_harness !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["trace_harness"],
        message: "must be present only when the report has a trace",
      });
    }
    if (!meta.has_trace && meta.truncated_trace) {
      context.addIssue({
        code: "custom",
        path: ["truncated_trace"],
        message: "must be false when the report has no trace",
      });
    }
    if (meta.parts[0]?.bytes !== meta.payload_bytes) {
      context.addIssue({
        code: "custom",
        path: ["payload_bytes"],
        message: "must match the payload part size",
      });
    }
  });
export type ReviewBugReportMetaV2 = z.infer<typeof ReviewBugReportMetaV2Schema>;

export const ReviewBugReportResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    report_id: z.uuid(),
    short_id: requiredString.length(12),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: requiredString,
  }),
]);
export type ReviewBugReportResponse = z.infer<
  typeof ReviewBugReportResponseSchema
>;

export function parseReviewBugReportRequest(
  value: JsonValue,
): ReviewBugReportRequest {
  return ReviewBugReportRequestSchema.parse(value);
}

export function parseReviewBugReportResponse(
  value: JsonValue,
): ReviewBugReportResponse {
  return ReviewBugReportResponseSchema.parse(value);
}
