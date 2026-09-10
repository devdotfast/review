import { z } from "zod";

import {
  HOST_LIMITS,
  HostBindingSchema,
  HostChangeSelectorSchema,
  HostDiagnosticSchema,
  HostDocumentCommitSchema,
  HostDocumentOperationSchema,
  HostDocumentSchema,
  HostHashSchema,
  HostIdSchema,
  HostKeySchema,
  HostLabelSchema,
  HostOidSchema,
  HostRelativePathSchema,
  HostSideSchema,
  HostSourceQuoteSchema,
  HostSourceRangeSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

export const HostRepinPlanSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  basedOnDocumentVersion: HostVersionSchema,
  binding: HostBindingSchema,
  anchorChanges: z
    .array(
      z.strictObject({
        id: HostKeySchema,
        before: HostSourceRangeSchema,
        proposed: HostSourceRangeSchema.nullable(),
        status: z.enum(["exact", "relocated", "missing"]),
      }),
    )
    .max(HOST_LIMITS.definitions),
  proposedDefinitions: HostDocumentSchema.shape.definitions,
  diagnostics: z.array(HostDiagnosticSchema).max(HOST_LIMITS.definitions),
  createdAt: HostTimeSchema,
});
export type HostRepinPlan = z.infer<typeof HostRepinPlanSchema>;

export const HOST_SOURCE_FILE_BYTES = 1024 * 1024;
export const HostSourceFileSchema = z.strictObject({
  repositoryId: HostIdSchema,
  commit: HostOidSchema,
  blob: HostOidSchema,
  file: HostRelativePathSchema,
  text: z
    .string()
    .max(HOST_SOURCE_FILE_BYTES)
    .refine(
      (text) =>
        new TextEncoder().encode(text).byteLength <= HOST_SOURCE_FILE_BYTES,
      "Source files may not exceed 1 MiB.",
    ),
  sha256: HostHashSchema,
});
export type HostSourceFile = z.infer<typeof HostSourceFileSchema>;

export const HOST_BINDING_COMMANDS = {
  "review.repin.plan": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedDocumentVersion: HostVersionSchema,
      change: HostChangeSelectorSchema,
    }),
    result: HostRepinPlanSchema,
  },
  "review.repin.apply": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      planId: HostIdSchema,
      expectedDocumentVersion: HostVersionSchema,
      operations: z
        .array(HostDocumentOperationSchema)
        .max(HOST_LIMITS.operations),
    }),
    result: HostDocumentCommitSchema,
  },
};

const sourceVersion = {
  reviewId: HostIdSchema,
  documentVersion: HostVersionSchema,
};
const sourcePageFields = {
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
function sourcePage<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(200),
    nextCursor: z.string().min(1).max(2_048).nullable(),
  });
}
export const HostSourceEntrySchema = z.strictObject({
  path: HostRelativePathSchema,
  kind: z.enum(["file", "directory", "symlink", "submodule"]),
  objectId: HostOidSchema,
  byteLength: z.number().int().nonnegative().optional(),
});
export const HostSourceCommitSchema = z.strictObject({
  oid: HostOidSchema,
  parents: z.array(HostOidSchema).max(100),
  subject: HostLabelSchema,
  author: HostLabelSchema,
  at: HostTimeSchema,
});
export const HostSourceDiffFileSchema = z.strictObject({
  path: HostRelativePathSchema,
  previousPath: HostRelativePathSchema.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const HOST_SOURCE_QUERIES = {
  "source.file": {
    permission: "read" as const,
    input: z.strictObject({
      ...sourceVersion,
      side: HostSideSchema,
      file: HostRelativePathSchema,
    }),
    result: HostSourceFileSchema,
  },
  "source.read": {
    permission: "read" as const,
    input: z.strictObject({ ...sourceVersion, range: HostSourceRangeSchema }),
    result: HostSourceQuoteSchema,
  },
  "source.tree": {
    permission: "read" as const,
    input: z.strictObject({
      ...sourceVersion,
      ...sourcePageFields,
      side: HostSideSchema,
      directory: HostRelativePathSchema.optional(),
    }),
    result: sourcePage(HostSourceEntrySchema),
  },
  "source.commits": {
    permission: "read" as const,
    input: z.strictObject({ ...sourceVersion, ...sourcePageFields }),
    result: sourcePage(HostSourceCommitSchema),
  },
  "source.diff": {
    permission: "read" as const,
    input: z.strictObject({ ...sourceVersion, ...sourcePageFields }),
    result: sourcePage(HostSourceDiffFileSchema),
  },
  "repin_plan.get": {
    permission: "read" as const,
    input: z.strictObject({ reviewId: HostIdSchema, planId: HostIdSchema }),
    result: HostRepinPlanSchema,
  },
};
