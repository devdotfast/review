import { z } from "zod";

import {
  HostHashSchema,
  HostIdSchema,
  HostLabelSchema,
  HostOidSchema,
  HostRelativePathSchema,
  HostSideSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

export const HOST_SOURCE_FILE_BYTES = 1024 * 1024;
export const HOST_SOURCE_QUOTE_BYTES = 256 * 1024;
export const HOST_SOURCE_COMMITS = 500;
export const HostLineRangeSchema = z
  .strictObject({
    fromLine: z.number().int().positive(),
    toLine: z.number().int().positive(),
  })
  .refine(
    (range) => range.toLine >= range.fromLine,
    "Source range must be ordered.",
  )
  .refine(
    (range) => range.toLine - range.fromLine + 1 <= 1_000,
    "Source ranges may not exceed 1,000 lines.",
  );

const sourceIdentity = {
  repositoryId: HostIdSchema,
  commit: HostOidSchema,
  blob: HostOidSchema,
  file: HostRelativePathSchema,
};
const sourceText = z
  .string()
  .max(HOST_SOURCE_FILE_BYTES)
  .refine(
    (text) =>
      new TextEncoder().encode(text).byteLength <= HOST_SOURCE_FILE_BYTES,
    "Source files may not exceed 1 MiB.",
  );
/** Internal whole-file value; the public API is the optional-range source.read. */
export const HostSourceFileSchema = z.strictObject({
  ...sourceIdentity,
  text: sourceText,
  sha256: HostHashSchema,
});
export type HostSourceFile = z.infer<typeof HostSourceFileSchema>;
export const HostSourceReadSchema = z
  .strictObject({
    ...sourceIdentity,
    range: HostLineRangeSchema.nullable(),
    text: sourceText,
    sha256: HostHashSchema,
  })
  .refine(
    (value) =>
      value.range === null ||
      new TextEncoder().encode(value.text).byteLength <=
        HOST_SOURCE_QUOTE_BYTES,
    "Source quotations may not exceed 256 KiB.",
  );
export type HostSourceRead = z.infer<typeof HostSourceReadSchema>;

const sourceVersion = {
  reviewId: HostIdSchema,
  reviewVersion: HostVersionSchema,
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
  "source.read": {
    permission: "read" as const,
    input: z.strictObject({
      ...sourceVersion,
      side: HostSideSchema,
      file: HostRelativePathSchema,
      range: HostLineRangeSchema.optional(),
      comparisonCommit: HostOidSchema.optional(),
    }),
    result: HostSourceReadSchema,
  },
  "source.tree": {
    permission: "read" as const,
    input: z.strictObject({
      ...sourceVersion,
      ...sourcePageFields,
      side: HostSideSchema,
      directory: HostRelativePathSchema.optional(),
      comparisonCommit: HostOidSchema.optional(),
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
    input: z.strictObject({
      ...sourceVersion,
      ...sourcePageFields,
      comparisonCommit: HostOidSchema.optional(),
    }),
    result: sourcePage(HostSourceDiffFileSchema),
  },
};
