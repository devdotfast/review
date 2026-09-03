// Store API contract. Keep byte-identical with
// <review repo>/packages/trace-shared/src/store-api.ts.
import { z } from "zod";

import { commitShaSchema, sessionIdSchema } from "./contracts.js";

export const TRACE_STORE_API_PREFIX = "/api/trace/v1" as const;
export const TRACE_STORE_CLIENT_ID = "review-cli" as const;
export const PRESIGNED_URL_TTL_SECONDS = 900 as const;

const nameSegment = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

export const traceHarnessSchema = z.enum(["claude", "codex", "pi"]);
export type TraceHarness = z.infer<typeof traceHarnessSchema>;

export const traceObjectNameSchema = z
  .string()
  .regex(/^(main\.jsonl\.gz|subagents\/[A-Za-z0-9_.-]{1,100}\.jsonl\.gz)$/);
export type TraceObjectName = z.infer<typeof traceObjectNameSchema>;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const createStoreRequestSchema = z.object({
  owner: nameSegment,
  name: nameSegment,
});
export type CreateStoreRequest = z.infer<typeof createStoreRequestSchema>;

export const findStoreQuerySchema = createStoreRequestSchema;

export const storeResponseSchema = z.object({
  repositoryId: z.number().int().positive(),
  displayName: z.string(),
  status: z.enum(["active", "deleting"]),
  createdAt: z.string(),
  created: z.boolean().optional(),
});
export type StoreResponse = z.infer<typeof storeResponseSchema>;

export const beginUploadRequestSchema = z.object({
  harness: traceHarnessSchema,
  objects: z
    .array(
      z.object({
        name: traceObjectNameSchema,
        size: z.number().int().positive(),
        sha256: sha256HexSchema,
      }),
    )
    .min(1)
    .max(64),
});
export type BeginUploadRequest = z.infer<typeof beginUploadRequestSchema>;

export const presignedUploadSchema = z.object({
  name: traceObjectNameSchema,
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});

export const beginUploadResponseSchema = z.object({
  uploads: z.array(presignedUploadSchema),
});
export type BeginUploadResponse = z.infer<typeof beginUploadResponseSchema>;

export const completeUploadRequestSchema = z.object({
  commits: z.array(commitShaSchema).max(200).default([]),
});
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;

export const storedObjectSchema = z.object({
  name: traceObjectNameSchema,
  size: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});

export const completeUploadResponseSchema = z.object({
  sessionId: sessionIdSchema,
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
  updatedAt: z.string(),
  commits: z.array(commitShaSchema),
  objects: z.array(
    storedObjectSchema.extend({
      url: z.string().url(),
      expiresAt: z.string(),
    }),
  ),
});

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionDownloadSchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const storeErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "github_unavailable",
  "upload_incomplete",
  "internal",
]);
export type StoreErrorCode = z.infer<typeof storeErrorCodeSchema>;

export const storeErrorEnvelopeSchema = z.object({
  error: z.object({ code: storeErrorCodeSchema, message: z.string() }),
});
export type StoreErrorEnvelope = z.infer<typeof storeErrorEnvelopeSchema>;

export function traceObjectKey(
  repositoryId: number,
  sessionId: string,
  name: TraceObjectName,
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) {
    throw new Error("repositoryId must be a positive integer");
  }
  sessionIdSchema.parse(sessionId);
  traceObjectNameSchema.parse(name);
  return `r${repositoryId}/sessions/${sessionId}/${name}`;
}
