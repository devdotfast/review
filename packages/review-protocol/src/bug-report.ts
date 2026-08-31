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

export const ReviewBugReportMetaSchema = z.strictObject({
  schema_version: z.literal(1),
  description_length: z.number().int().nonnegative().max(65_536),
  has_review: z.boolean(),
  has_map: z.boolean(),
  has_diff: z.boolean(),
  has_screenshot: z.boolean(),
  has_trace: z.boolean().default(false),
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
  truncated_trace: z.boolean().default(false),
});
export type ReviewBugReportMeta = z.infer<typeof ReviewBugReportMetaSchema>;

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

export function parseReviewBugReportMeta(value: unknown): ReviewBugReportMeta {
  return ReviewBugReportMetaSchema.parse(value);
}

export function parseReviewBugReportResponse(
  value: unknown,
): ReviewBugReportResponse {
  return ReviewBugReportResponseSchema.parse(value);
}
