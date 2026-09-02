import { z } from "zod";

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
    field: z.literal("source_trace"),
    filename: z.literal("source.jsonl.gz"),
    bytes: compressedPartBytes,
    sha256: compressedSha256,
    session_id: requiredString.max(128),
  }),
  z.strictObject({
    field: z.literal("parent_trace"),
    filename: z.literal("parent.jsonl.gz"),
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
    parts: z.array(ReviewBugReportPartSchema).min(1).max(3),
  })
  .superRefine((meta, context) => {
    const fields = meta.parts.map((part) => part.field);
    const hasParent = fields.includes("parent_trace");
    const expected = meta.has_trace
      ? hasParent
        ? ["payload", "source_trace", "parent_trace"]
        : ["payload", "source_trace"]
      : ["payload"];
    if (
      fields.length !== expected.length ||
      fields.some((field, index) => field !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message:
          "must list payload and the optional source and parent traces in order",
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
  value: unknown,
): ReviewBugReportRequest {
  return ReviewBugReportRequestSchema.parse(value);
}

export function parseReviewBugReportResponse(
  value: unknown,
): ReviewBugReportResponse {
  return ReviewBugReportResponseSchema.parse(value);
}
