import { z } from "zod";

import { commitShaSchema, sessionIdSchema } from "./contracts.js";

export const TRACE_STORE_API_PREFIX = "/api/trace/v1" as const;
export const TRACE_STORE_CLIENT_ID = "review-cli" as const;
export const PRESIGNED_URL_TTL_SECONDS = 900 as const;

/** Largest single trace object the store accepts. */
export const MAX_TRACE_OBJECT_BYTES = 256 * 1024 * 1024;
/** Largest total size of one session's declared objects. */
export const MAX_TRACE_SESSION_BYTES = 1024 * 1024 * 1024;
/** Most objects one upload can declare. */
export const MAX_TRACE_OBJECTS = 64;
/** Most commits one completion can link. */
export const MAX_TRACE_COMMITS = 200;
/** Largest JSON body a metadata request may carry. Object bytes go to S3. */
export const MAX_TRACE_METADATA_BODY_BYTES = 64 * 1024;

const nameSegment = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

export const traceHarnessSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type TraceHarness = z.infer<typeof traceHarnessSchema>;

export const traceObjectNameSchema = z
  .string()
  .regex(/^(main\.jsonl\.gz|subagents\/[A-Za-z0-9_.-]{1,100}\.jsonl\.gz)$/);
export type TraceObjectName = z.infer<typeof traceObjectNameSchema>;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A store instance or an upload. The server mints one per onboarding and one
 * per begin call; neither value is ever reused.
 */
export const storeIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const uploadIdSchema = storeIdSchema;

export const createStoreRequestSchema = z.object({
  owner: nameSegment,
  name: nameSegment,
});
export type CreateStoreRequest = z.infer<typeof createStoreRequestSchema>;

export const findStoreQuerySchema = createStoreRequestSchema;

export const storeResponseSchema = z.object({
  repositoryId: z.number().int().positive(),
  /** The current store instance. Deleting a store retires its id. */
  storeId: storeIdSchema,
  displayName: z.string(),
  status: z.enum(["active", "deleting"]),
  createdAt: z.string(),
  created: z.boolean().optional(),
});
export type StoreResponse = z.infer<typeof storeResponseSchema>;

/**
 * Deletion is logical. The store stops every read and write at once; an
 * operator removes the objects later, after outstanding URLs expire.
 */
export const deleteStoreResponseSchema = z.object({
  repositoryId: z.number().int().positive(),
  storeId: storeIdSchema,
  status: z.literal("deleting"),
  deletedAt: z.string(),
});
export type DeleteStoreResponse = z.infer<typeof deleteStoreResponseSchema>;

export const declaredObjectSchema = z.object({
  name: traceObjectNameSchema,
  size: z.number().int().positive().max(MAX_TRACE_OBJECT_BYTES),
  sha256: sha256HexSchema,
});
export type DeclaredObject = z.infer<typeof declaredObjectSchema>;

/** The complete object set of one upload. Names are unique. */
export const uploadManifestSchema = z
  .array(declaredObjectSchema)
  .min(1)
  .max(MAX_TRACE_OBJECTS)
  .superRefine((objects, context) => {
    const seen = new Set<string>();
    let total = 0;
    for (const object of objects) {
      if (seen.has(object.name)) {
        context.addIssue({
          code: "custom",
          message: `Object ${object.name} is declared twice.`,
        });
      }
      seen.add(object.name);
      total += object.size;
    }
    if (total > MAX_TRACE_SESSION_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Declared upload exceeds the session limit.",
      });
    }
  });
export type UploadManifest = z.infer<typeof uploadManifestSchema>;

export const beginUploadRequestSchema = z.object({
  harness: traceHarnessSchema,
  objects: uploadManifestSchema,
});
export type BeginUploadRequest = z.infer<typeof beginUploadRequestSchema>;

export const presignedUploadSchema = z.object({
  name: traceObjectNameSchema,
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type PresignedUpload = z.infer<typeof presignedUploadSchema>;

export const beginUploadResponseSchema = z.object({
  /** Names this upload in every later call. */
  uploadId: uploadIdSchema,
  storeId: storeIdSchema,
  /**
   * The session generation this upload replaces. Zero means the session has
   * no published upload. Completion fails with `stale_upload` when another
   * upload publishes first.
   */
  baseGeneration: z.number().int().nonnegative(),
  uploads: z.array(presignedUploadSchema),
});
export type BeginUploadResponse = z.infer<typeof beginUploadResponseSchema>;

export const completeUploadRequestSchema = z.object({
  commits: z
    .array(commitShaSchema)
    .max(MAX_TRACE_COMMITS)
    .default([])
    .refine((commits) => new Set(commits).size === commits.length, {
      message: "A commit is listed twice.",
    }),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

export const storedObjectSchema = z.object({
  name: traceObjectNameSchema,
  size: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});
export type StoredObject = z.infer<typeof storedObjectSchema>;

/**
 * The receipt of one completed upload. Repeating a completion returns the
 * same receipt; it never moves the session to an older upload.
 */
export const completeUploadResponseSchema = z.object({
  sessionId: sessionIdSchema,
  uploadId: uploadIdSchema,
  generation: z.number().int().positive(),
  objects: z.array(storedObjectSchema),
  commits: z.array(commitShaSchema),
});
export type CompleteUploadResponse = z.infer<
  typeof completeUploadResponseSchema
>;

export const listSessionsQuerySchema = z
  .object({
    commit: commitShaSchema.optional(),
    session: sessionIdSchema.optional(),
  })
  .refine((q) => q.commit !== undefined || q.session !== undefined, {
    message: "commit or session is required",
  });
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const sessionDownloadSchema = z.object({
  sessionId: sessionIdSchema,
  harness: traceHarnessSchema,
  /** The published upload. Clients key caches by it and by each checksum. */
  uploadId: uploadIdSchema,
  generation: z.number().int().positive(),
  updatedAt: z.string(),
  commits: z.array(commitShaSchema),
  objects: z.array(
    storedObjectSchema.extend({
      url: z.string().url(),
      expiresAt: z.string(),
    }),
  ),
});
export type SessionDownload = z.infer<typeof sessionDownloadSchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionDownloadSchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const storeErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "payload_too_large",
  "github_unavailable",
  "upload_incomplete",
  /** Another upload published after this one began. Start a new upload. */
  "stale_upload",
  /** The store was deleted. No read or write works until it is onboarded again. */
  "store_deleted",
  /** The client speaks an older protocol than the server. */
  "upgrade_required",
  "internal",
]);
export type StoreErrorCode = z.infer<typeof storeErrorCodeSchema>;

export const storeErrorEnvelopeSchema = z.object({
  error: z.object({ code: storeErrorCodeSchema, message: z.string() }),
});
export type StoreErrorEnvelope = z.infer<typeof storeErrorEnvelopeSchema>;

/** The object key prefix of one repository. Accounting groups by it. */
export function traceRepositoryPrefix(repositoryId: number): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) {
    throw new Error("repositoryId must be a positive integer");
  }
  return `r${repositoryId}/`;
}

/**
 * The immutable key of one uploaded object. The store and upload ids sit
 * beneath the repository prefix, so a URL signed for one upload can never
 * address another upload's object.
 */
export function traceObjectKey(input: {
  repositoryId: number;
  storeId: string;
  sessionId: string;
  uploadId: string;
  name: TraceObjectName;
}): string {
  storeIdSchema.parse(input.storeId);
  uploadIdSchema.parse(input.uploadId);
  sessionIdSchema.parse(input.sessionId);
  traceObjectNameSchema.parse(input.name);
  return `${traceRepositoryPrefix(input.repositoryId)}stores/${input.storeId}/sessions/${input.sessionId}/uploads/${input.uploadId}/${input.name}`;
}

/**
 * Why a begin response does not match the manifest it answers, or null when
 * every declared object has exactly one presigned upload and nothing else.
 */
export function uploadManifestMismatch(
  manifest: ReadonlyArray<Pick<DeclaredObject, "name">>,
  uploads: ReadonlyArray<Pick<PresignedUpload, "name">>,
): string | null {
  const declared = new Set(manifest.map((object) => object.name));
  const seen = new Set<string>();
  for (const upload of uploads) {
    if (!declared.has(upload.name)) {
      return `The store offered an upload this session did not declare: ${upload.name}.`;
    }
    if (seen.has(upload.name)) {
      return `The store offered ${upload.name} twice.`;
    }
    seen.add(upload.name);
  }
  for (const name of declared) {
    if (!seen.has(name)) {
      return `The store offered no upload for ${name}.`;
    }
  }
  return null;
}
