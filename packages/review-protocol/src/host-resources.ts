import { z } from "zod";

import {
  HOST_LIMITS,
  HostHashSchema,
  HostIdSchema,
  HostLabelSchema,
  HostMapOperationSchema,
  HostMapSchema,
  HostMapVersionSchema,
  HostSideSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

export const HOST_RESOURCE_LIMITS = {
  assetUploadRequestBytes: 8 * 1024 * 1024,
  mapBytes: 4 * 1024 * 1024,
  mapEvidenceBytes: 4 * 1024 * 1024,
  traceBytes: 1024 * 1024,
  traceEvents: 200,
  traceEventBytes: 128 * 1024,
} as const;

const resourceBase64 = z
  .string()
  .min(4)
  .max(4 * Math.ceil(HOST_LIMITS.assetBytes / 3))
  // A repeated four-character group can overflow the JS regexp stack on a
  // multi-megabyte upload. Canonical padding is checked after decoding.
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const HostAssetSchema = z.strictObject({
  id: HostIdSchema,
  sha256: HostHashSchema,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteLength: z.number().int().positive().max(HOST_LIMITS.assetBytes),
  width: z.number().int().positive().max(HOST_LIMITS.assetPixels),
  height: z.number().int().positive().max(HOST_LIMITS.assetPixels),
  createdAt: HostTimeSchema,
});
export type HostAsset = z.infer<typeof HostAssetSchema>;

const resourceTraceEventFields = {
  id: HostIdSchema,
  ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: HostTimeSchema,
  kind: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
  text: z.string().max(HOST_RESOURCE_LIMITS.traceEventBytes),
  toolName: HostLabelSchema.optional(),
};
export const HostTraceEventInputSchema = z.strictObject(
  resourceTraceEventFields,
);
export const HostTraceEventSchema = z.strictObject({
  ...resourceTraceEventFields,
  traceId: HostIdSchema,
  contentHash: HostHashSchema,
});
export type HostTraceEvent = z.infer<typeof HostTraceEventSchema>;
export const HostTraceSchema = z.strictObject({
  id: HostIdSchema,
  sessionId: z.null(),
  parentTraceId: HostIdSchema.nullable(),
  label: HostLabelSchema,
  version: z.literal(0),
  createdAt: HostTimeSchema,
  // External material is inert evidence, never proof of a forkable session.
  provenance: z.literal("client_supplied"),
});
export type HostTrace = z.infer<typeof HostTraceSchema>;
export const HostRetainedTraceSchema = z.strictObject({
  trace: HostTraceSchema,
  events: z
    .array(HostTraceEventSchema)
    .min(1)
    .max(HOST_RESOURCE_LIMITS.traceEvents),
});
export type HostRetainedTrace = z.infer<typeof HostRetainedTraceSchema>;

export const HostMapSummarySchema = HostMapVersionSchema.pick({
  id: true,
  mapId: true,
  repositoryId: true,
  commit: true,
  revision: true,
  contentHash: true,
  createdAt: true,
});
export type HostMapSummary = z.infer<typeof HostMapSummarySchema>;
export const HostResourcePageSchema = z.strictObject({
  reviewId: HostIdSchema,
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const HOST_RESOURCE_COMMANDS = {
  "map.create": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      documentVersion: HostVersionSchema,
      side: HostSideSchema,
      map: HostMapSchema,
    }),
    result: HostMapVersionSchema,
  },
  "map.mutate": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      mapId: HostIdSchema,
      expectedVersion: HostVersionSchema,
      operations: z
        .array(HostMapOperationSchema)
        .min(1)
        .max(HOST_LIMITS.operations),
    }),
    result: HostMapVersionSchema,
  },
  "trace.ingest": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      parentTraceId: HostIdSchema.optional(),
      label: HostLabelSchema,
      events: z
        .array(HostTraceEventInputSchema)
        .min(1)
        .max(HOST_RESOURCE_LIMITS.traceEvents),
    }),
    result: HostTraceSchema,
  },
  "asset.upload": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      mimeType: HostAssetSchema.shape.mimeType,
      base64: resourceBase64,
    }),
    result: HostAssetSchema,
  },
};

export const HOST_RESOURCE_QUERIES = {
  "map.get": {
    permission: "read" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      mapVersionId: HostIdSchema,
    }),
    result: HostMapVersionSchema,
  },
  "maps.list": {
    permission: "read" as const,
    input: HostResourcePageSchema.extend({ mapId: HostIdSchema.optional() }),
    result: z.strictObject({
      items: z.array(HostMapSummarySchema).max(200),
      nextCursor: z.string().min(1).max(2_048).nullable(),
    }),
  },
  "trace.get": {
    permission: "read" as const,
    input: z.strictObject({ reviewId: HostIdSchema, traceId: HostIdSchema }),
    result: HostRetainedTraceSchema,
  },
  "asset.get": {
    permission: "read" as const,
    input: z.strictObject({ reviewId: HostIdSchema, assetId: HostIdSchema }),
    result: z.strictObject({ asset: HostAssetSchema, base64: resourceBase64 }),
  },
};

export type HostResourceCommandName = keyof typeof HOST_RESOURCE_COMMANDS;
export type HostResourceCommand = {
  [K in HostResourceCommandName]: {
    type: K;
    input: z.infer<(typeof HOST_RESOURCE_COMMANDS)[K]["input"]>;
  };
}[HostResourceCommandName];
export type HostResourceQueryName = keyof typeof HOST_RESOURCE_QUERIES;
export type HostResourceQuery = {
  [K in HostResourceQueryName]: {
    type: K;
    input: z.infer<(typeof HOST_RESOURCE_QUERIES)[K]["input"]>;
  };
}[HostResourceQueryName];
