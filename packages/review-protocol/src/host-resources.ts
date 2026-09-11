import { z } from "zod";

import {
  HOST_LIMITS,
  HostHashSchema,
  HostIdSchema,
  HostKeySchema,
  HostLabelSchema,
  HostMapElementSchema,
  HostMapRelationshipSchema,
  HostMapVersionSchema,
  HostOidSchema,
  HostRelativePathSchema,
  HostSideSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";
import { HostLineRangeSchema } from "./host-source.js";

export const HOST_RESOURCE_LIMITS = {
  assetUploadRequestBytes: 8 * 1024 * 1024,
  mapRequestBytes: 8 * 1024 * 1024,
  mapBytes: 4 * 1024 * 1024,
  mapEvidenceBytes: 4 * 1024 * 1024,
  traceBytes: 1024 * 1024,
  traceEvents: 200,
  traceEventBytes: 128 * 1024,
  analysisDiffBytes: 16 * 1024 * 1024,
  analysisRangeChecks: 2_000_000,
  analysisResponseBytes: 4 * 1024 * 1024,
} as const;

export const HostSourceLocatorSchema = z
  .strictObject({
    ...HostLineRangeSchema.shape,
    file: HostRelativePathSchema,
  })
  .refine(
    (locator) =>
      locator.toLine >= locator.fromLine &&
      locator.toLine - locator.fromLine + 1 <= 1000,
    "Source locators must be ordered and contain at most 1,000 lines.",
  );
export type HostSourceLocator = z.infer<typeof HostSourceLocatorSchema>;
export const HostAuthoredMapElementSchema = HostMapElementSchema.extend({
  source: z.array(HostSourceLocatorSchema).max(HOST_LIMITS.diagramItems),
});
export const HostAuthoredMapRelationshipSchema = z.discriminatedUnion("kind", [
  HostMapRelationshipSchema.options[0].extend({
    evidence: HostSourceLocatorSchema,
  }),
  HostMapRelationshipSchema.options[1],
]);
function mapRecord<T extends z.ZodType>(schema: T, limit: number) {
  const record = z
    .record(HostKeySchema, schema)
    .refine(
      (value) => Object.keys(value).length <= limit,
      `Map exceeds ${limit} entries.`,
    )
    .meta({ maxProperties: limit });
  const jsonSchema = z.toJSONSchema(record, { io: "input" });
  delete jsonSchema.$schema;
  // SAFETY: The preprocessor only rejects forbidden keys; the record schema
  // still validates both the accepted input and the normalized output.
  return z
    .preprocess((value, context) => {
      if (
        value !== null &&
        value !== undefined &&
        Object.prototype.hasOwnProperty.call(value, "__proto__")
      ) {
        context.addIssue({
          code: "custom",
          message: "__proto__ is not a permitted map key",
        });
        return z.NEVER;
      }
      return value;
    }, record)
    .meta(jsonSchema) as z.ZodType<
    Record<string, z.output<T>>,
    Record<string, z.input<T>>
  >;
}
export const HostAuthoredMapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  elements: mapRecord(HostAuthoredMapElementSchema, HOST_LIMITS.mapElements),
  relationships: mapRecord(
    HostAuthoredMapRelationshipSchema,
    HOST_LIMITS.mapRelationships,
  ),
});
export type HostAuthoredMap = z.infer<typeof HostAuthoredMapSchema>;
export const HostAuthoredMapOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("element.put"),
    element: HostAuthoredMapElementSchema,
  }),
  z.strictObject({ op: z.literal("element.remove"), id: HostKeySchema }),
  z.strictObject({
    op: z.literal("relationship.put"),
    relationship: HostAuthoredMapRelationshipSchema,
  }),
  z.strictObject({ op: z.literal("relationship.remove"), id: HostKeySchema }),
]);
export type HostAuthoredMapOperation = z.infer<
  typeof HostAuthoredMapOperationSchema
>;

const resourceBase64 = z
  .string()
  .min(4)
  .max(4 * Math.ceil(HOST_LIMITS.assetBytes / 3))
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const HostAssetSchema = z
  .strictObject({
    id: HostIdSchema,
    sha256: HostHashSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().positive().max(HOST_LIMITS.assetBytes),
    width: z.number().int().positive().max(HOST_LIMITS.assetPixels),
    height: z.number().int().positive().max(HOST_LIMITS.assetPixels),
    createdAt: HostTimeSchema,
  })
  .refine(
    (asset) => asset.width * asset.height <= HOST_LIMITS.assetPixels,
    "Image exceeds the maximum pixel count.",
  );
export type HostAsset = z.infer<typeof HostAssetSchema>;

const traceFields = {
  id: HostIdSchema,
  kind: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
  text: z
    .string()
    .max(HOST_RESOURCE_LIMITS.traceEventBytes)
    .refine(
      (text) =>
        /\S/.test(text) &&
        new TextEncoder().encode(text).byteLength <=
          HOST_RESOURCE_LIMITS.traceEventBytes,
      "Trace events must contain nonblank text of at most 128 KiB UTF-8.",
    ),
  toolName: HostLabelSchema.optional(),
};
function validToolName(event: { kind: string; toolName?: string }) {
  return (
    event.toolName === undefined ||
    event.kind === "tool_call" ||
    event.kind === "tool_result"
  );
}
export const HostTraceEventInputSchema = z
  .strictObject({
    ...traceFields,
    at: HostTimeSchema.optional(),
  })
  .refine(validToolName, "toolName applies only to tool events.");
export const HostTraceEventSchema = z
  .strictObject({
    ...traceFields,
    at: HostTimeSchema.nullable(),
    ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    traceId: HostIdSchema,
    contentHash: HostHashSchema,
  })
  .refine(validToolName, "toolName applies only to tool events.");
export type HostTraceEvent = z.infer<typeof HostTraceEventSchema>;
export const HostTraceSchema = z.strictObject({
  id: HostIdSchema,
  label: HostLabelSchema,
  createdAt: HostTimeSchema,
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
  mapVersion: true,
  contentHash: true,
  createdAt: true,
});
export type HostMapSummary = z.infer<typeof HostMapSummarySchema>;
export const HostResourcePageSchema = z.strictObject({
  reviewId: HostIdSchema,
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const HostMapSelectionSchema = z.strictObject({
  base: HostIdSchema.nullable(),
  head: HostIdSchema.nullable(),
});
export const HostMapAnalysisInputSchema = HostResourcePageSchema.extend({
  reviewVersion: HostVersionSchema,
  mapVersions: HostMapSelectionSchema.optional(),
  elementIds: z
    .array(HostKeySchema)
    .min(1)
    .max(200)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Element IDs must be unique.",
    )
    .optional(),
  includeDiff: z.boolean().optional(),
});
const analysisLine = z
  .strictObject({
    kind: z.enum(["add", "remove"]),
    baseLine: z.number().int().positive().nullable(),
    headLine: z.number().int().positive().nullable(),
    text: z.string().max(HOST_RESOURCE_LIMITS.analysisResponseBytes),
  })
  .refine(
    (line) =>
      line.kind === "add"
        ? line.baseLine === null && line.headLine !== null
        : line.baseLine !== null && line.headLine === null,
    "Changed rows must identify exactly their source side.",
  );
const hunkRange = z.strictObject({
  startLine: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
});
export const HostMapElementAnalysisSchema = z.strictObject({
  elementId: HostKeySchema,
  presence: z.strictObject({ base: z.boolean(), head: z.boolean() }),
  changeStatus: z.enum(["added", "removed", "modified", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: z
    .strictObject({
      files: z.array(
        z.strictObject({
          baseFile: HostRelativePathSchema.nullable(),
          headFile: HostRelativePathSchema.nullable(),
          hunks: z.array(
            z.strictObject({
              baseRange: hunkRange,
              headRange: hunkRange,
              attribution: z.enum(["overlap", "boundary"]),
              lines: z.array(analysisLine),
            }),
          ),
        }),
      ),
    })
    .optional(),
});
export type HostMapElementAnalysis = z.infer<
  typeof HostMapElementAnalysisSchema
>;
export const HostMapAnalysisSchema = z.strictObject({
  reviewVersion: HostVersionSchema,
  mapVersions: HostMapSelectionSchema,
  comparison: z.strictObject({
    baseCommit: HostOidSchema,
    headCommit: HostOidSchema,
  }),
  items: z.array(HostMapElementAnalysisSchema).max(200),
  nextCursor: z.string().min(1).max(2_048).nullable(),
});
export type HostMapAnalysis = z.infer<typeof HostMapAnalysisSchema>;
export type HostMapAnalysisInput = z.infer<typeof HostMapAnalysisInputSchema>;

export const HOST_RESOURCE_COMMANDS = {
  "map.create": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      reviewVersion: HostVersionSchema,
      side: HostSideSchema,
      map: HostAuthoredMapSchema,
    }),
    result: HostMapVersionSchema,
  },
  "map.mutate": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
      mapId: HostIdSchema,
      expectedMapVersion: HostVersionSchema,
      operations: z
        .array(HostAuthoredMapOperationSchema)
        .min(1)
        .max(HOST_LIMITS.operations),
    }),
    result: HostMapVersionSchema,
  },
  "trace.ingest": {
    permission: "author" as const,
    input: z.strictObject({
      reviewId: HostIdSchema,
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
  "map.analyze": {
    permission: "read" as const,
    input: HostMapAnalysisInputSchema,
    result: HostMapAnalysisSchema,
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
    input: z.input<(typeof HOST_RESOURCE_COMMANDS)[K]["input"]>;
  };
}[HostResourceCommandName];
export type HostResourceQueryName = keyof typeof HOST_RESOURCE_QUERIES;
export type HostResourceQuery = {
  [K in HostResourceQueryName]: {
    type: K;
    input: z.infer<(typeof HOST_RESOURCE_QUERIES)[K]["input"]>;
  };
}[HostResourceQueryName];
