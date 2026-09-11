import { z } from "zod";

import { HOST_SUPPORT_LIMITS } from "./host-api.js";
import { HostApiErrorSchema } from "./host-commands.js";
import { HostIdSchema, HostVersionSchema } from "./host-document.js";

export { HOST_SUPPORT_LIMITS } from "./host-api.js";
export const HostSupportReportSchema = z.strictObject({
  description: z
    .string()
    .max(HOST_SUPPORT_LIMITS.descriptionBytes)
    .refine(
      (value) =>
        new TextEncoder().encode(value).byteLength <=
        HOST_SUPPORT_LIMITS.descriptionBytes,
      "Description may not exceed 64 KiB UTF-8.",
    ),
  include_review: z.boolean(),
  include_map: z.boolean(),
  include_diff: z.boolean(),
  screenshot: z
    .strictObject({
      mime: z.literal("image/jpeg"),
      base64: z
        .string()
        .min(4)
        .max(4 * Math.ceil(HOST_SUPPORT_LIMITS.screenshotBytes / 3))
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .optional(),
  app_session_id: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
  app_version: z
    .string()
    .min(1)
    .max(100)
    .refine(
      (value) => value.trim().length > 0,
      "App version must be nonblank.",
    ),
});
export type HostSupportReport = z.infer<typeof HostSupportReportSchema>;
export const HostBugReportInputSchema = z.strictObject({
  reviewVersion: HostVersionSchema,
  report: HostSupportReportSchema,
});
export type HostBugReportInput = z.infer<typeof HostBugReportInputSchema>;
export const HostSupportWarningSchema = z.strictObject({
  attachment: z.enum(["review", "map", "diff", "screenshot"]),
  code: z.enum(["unavailable", "size_limit"]),
  message: z.string().min(1).max(2048),
});
export type HostSupportWarning = z.infer<typeof HostSupportWarningSchema>;
export const HostBugReportResultSchema = z.strictObject({
  reportId: HostIdSchema,
  shortId: z
    .string()
    .length(12)
    .refine(
      (value) => value.trim().length > 0,
      "Report code must be nonblank.",
    ),
  warnings: z
    .array(HostSupportWarningSchema)
    .max(4)
    .refine(
      (values) =>
        new Set(values.map((value) => value.attachment)).size === values.length,
      "Only one warning per attachment is allowed.",
    ),
});
export const HostBugReportResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: HostBugReportResultSchema }),
  z.strictObject({ ok: z.literal(false), error: HostApiErrorSchema }),
]);
