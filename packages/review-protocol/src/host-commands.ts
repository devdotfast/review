import { z } from "zod";

import {
  HOST_ACTIVITY_COMMANDS,
  HOST_ACTIVITY_QUERIES,
} from "./host-activity.js";
import {
  HOST_SUPPORT_LIMITS,
  HostRepositorySchema,
  HostReviewCommitSchema,
  HostReviewStateSchema,
  HostReviewVersionHeaderSchema,
  HostReviewVersionSummarySchema,
  HostReviewWithSnapshotSchema,
} from "./host-api.js";
import {
  HOST_LIMITS,
  HostChangeSelectorSchema,
  HostDiagnosticSchema,
  HostDocumentOperationSchema,
  HostDocumentSchema,
  HostDocumentStateSchema,
  HostIdSchema,
  HostKeySchema,
  HostLabelSchema,
  HostNodeSchema,
  HostTextSchema,
  HostTimeSchema,
  HostValidationReportSchema,
  HostVersionSchema,
} from "./host-document.js";
import {
  HOST_FEEDBACK_COMMANDS,
  HOST_FEEDBACK_QUERIES,
} from "./host-feedback.js";
import {
  HOST_RESOURCE_COMMANDS,
  HOST_RESOURCE_LIMITS,
  HOST_RESOURCE_QUERIES,
} from "./host-resources.js";
import {
  HOST_SOURCE_COMMITS,
  HOST_SOURCE_FILE_BYTES,
  HOST_SOURCE_QUERIES,
  HOST_SOURCE_QUOTE_BYTES,
} from "./host-source.js";

export const HostCursorSchema = z.string().min(1).max(2_048);
const pageFields = {
  cursor: HostCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
function page<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(200),
    nextCursor: HostCursorSchema.nullable(),
  });
}
const reviewVersion = z.strictObject({
  reviewId: HostIdSchema,
  expectedStateVersion: HostVersionSchema,
});
const documentMutation = z.strictObject({
  reviewId: HostIdSchema,
  expectedReviewVersion: HostVersionSchema,
  operations: z
    .array(HostDocumentOperationSchema)
    .min(1)
    .max(HOST_LIMITS.operations),
});
export const HostPermissionSchema = z.enum([
  "read",
  "author",
  "human",
  "answer",
  "register_repository",
]);
export type HostPermission = z.infer<typeof HostPermissionSchema>;
interface HostOperationDefinition {
  input: z.ZodObject;
  result: z.ZodType;
  permission: HostPermission;
}

/** These paired schemas are the single definition of each operation's contract. */
export const HOST_COMMAND_DEFINITIONS = {
  ...HOST_ACTIVITY_COMMANDS,
  ...HOST_RESOURCE_COMMANDS,
  ...HOST_FEEDBACK_COMMANDS,
  "repository.register": {
    permission: "register_repository",
    input: z.strictObject({
      path: z
        .string()
        .min(1)
        .max(4_096)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
    }),
    result: HostRepositorySchema,
  },
  "review.create": {
    permission: "author",
    input: z.strictObject({
      repositoryId: HostIdSchema,
      change: HostChangeSelectorSchema,
      title: HostLabelSchema,
      description: HostTextSchema.optional(),
      labels: HostReviewVersionHeaderSchema.shape.labels.optional(),
    }),
    result: HostReviewWithSnapshotSchema.extend({
      document: HostDocumentStateSchema,
    }),
  },
  "review.update": {
    permission: "author",
    input: z
      .strictObject({
        reviewId: HostIdSchema,
        expectedReviewVersion: HostVersionSchema,
        title: HostLabelSchema.optional(),
        description: HostTextSchema.optional(),
        labels: HostReviewVersionHeaderSchema.shape.labels.optional(),
        mapVersions: z
          .strictObject({
            base: HostIdSchema.nullable().optional(),
            head: HostIdSchema.nullable().optional(),
          })
          .refine(
            (value) => Object.keys(value).length > 0,
            "Supply at least one map side.",
          )
          .optional(),
      })
      .refine(
        (value) =>
          Object.keys(value).some(
            (key) => key !== "reviewId" && key !== "expectedReviewVersion",
          ),
        "Supply at least one editable field.",
      ),
    result: HostReviewCommitSchema,
  },
  "review.close": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewStateSchema,
  },
  "review.reopen": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewStateSchema,
  },
  "review.trash": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewStateSchema,
  },
  "review.untrash": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewStateSchema,
  },
  "document.mutate": {
    permission: "author",
    input: documentMutation,
    result: HostReviewCommitSchema,
  },
  "document.replace": {
    permission: "author",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedReviewVersion: HostVersionSchema,
      document: HostDocumentSchema,
    }),
    result: HostReviewCommitSchema,
  },
  "review.version.restore": {
    permission: "author",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedReviewVersion: HostVersionSchema,
      fromReviewVersion: HostVersionSchema,
    }),
    result: HostReviewCommitSchema,
  },
  "review.revision.create": {
    permission: "author",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedReviewVersion: HostVersionSchema,
      change: HostChangeSelectorSchema,
    }),
    result: HostReviewCommitSchema,
  },
} satisfies Record<string, HostOperationDefinition>;
export type HostCommandName = keyof typeof HOST_COMMAND_DEFINITIONS;
export type HostCommandInputs = {
  [K in HostCommandName]: z.input<
    (typeof HOST_COMMAND_DEFINITIONS)[K]["input"]
  >;
};
export type HostCommandResults = {
  [K in HostCommandName]: z.infer<
    (typeof HOST_COMMAND_DEFINITIONS)[K]["result"]
  >;
};

const HostNodeTypeSchema = z.union(
  HostNodeSchema.options.map((node) => node.shape.type),
);
const operationName = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
export const HOST_CAPABILITY_LIMITS = Object.freeze({
  ...HOST_LIMITS,
  ...HOST_RESOURCE_LIMITS,
  documentReplaceRequestBytes: 5 * 1024 * 1024,
  nativeOpenRequestBytes: 1024 * 1024,
  sourceFileBytes: HOST_SOURCE_FILE_BYTES,
  sourceQuoteBytes: HOST_SOURCE_QUOTE_BYTES,
  sourceCommits: HOST_SOURCE_COMMITS,
  mapSourceRangesPerElement: HOST_LIMITS.diagramItems,
  storeCollections: HOST_LIMITS.definitions,
  storeFieldsPerCollection: HOST_LIMITS.definitions,
  feedbackDrafts: 200,
  feedbackResultIds: 201,
  listEntriesMin: 1,
  listEntriesMax: 200,
  listEntriesDefault: 100,
  cursorCharacters: 2_048,
  selectedNodeIds: HOST_LIMITS.nodes,
  selectedAnchorIds: HOST_LIMITS.definitions,
  labelCharacters: 2_048,
  authoredTextCharacters: HOST_LIMITS.nodeBytes,
  selectionQuoteCharacters: 32_768,
  selectionPrefixCharacters: 256,
  selectionSuffixCharacters: 256,
  questionContextBytes: 56 * 1024,
  questionContextMessages: 8,
  questionContextMessageBytes: 1_000,
  questionContextTitleBytes: 1_000,
  questionContextSourceBytes: 4_000,
  questionContextCanvasBytes: 8_000,
  eventFrameBytes: 1024 * 1024,
  eventPatchBytes: 256 * 1024,
  eventHeartbeatMs: 15_000,
  activityLeaseMs: 60_000,
  activityIdentities: 512,
  activityRoutineReceipts: 16_384,
  activityReservedEndReceipts: 512,
  supportRequestBytes: HOST_SUPPORT_LIMITS.requestBytes,
  supportDescriptionBytes: HOST_SUPPORT_LIMITS.descriptionBytes,
  supportScreenshotBytes: HOST_SUPPORT_LIMITS.screenshotBytes,
});
export const HostCapabilitiesSchema = z.strictObject({
  apiVersions: z.array(z.number().int().positive()).max(10),
  documentSchemaVersions: z.array(z.number().int().positive()).max(10),
  nodeTypes: z.array(HostNodeTypeSchema).max(100),
  limits: z.strictObject(
    Object.fromEntries(
      Object.keys(HOST_CAPABILITY_LIMITS).map((key) => [
        key,
        z.number().int().nonnegative(),
      ]),
    ),
  ),
  commands: z.array(operationName).max(500),
  queries: z.array(operationName).max(500),
  ask: z.strictObject({
    supportedHarnesses: z.array(z.enum(["claude-code", "codex", "pi"])).max(3),
    defaultHarness: z.enum(["claude-code", "codex", "pi"]).nullable(),
    isolation: z.literal("trusted_local"),
  }),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export const HOST_QUERY_DEFINITIONS = {
  ...HOST_ACTIVITY_QUERIES,
  ...HOST_SOURCE_QUERIES,
  ...HOST_RESOURCE_QUERIES,
  ...HOST_FEEDBACK_QUERIES,
  capabilities: {
    permission: "read",
    input: z.strictObject({}),
    result: HostCapabilitiesSchema,
  },
  "repositories.list": {
    permission: "read",
    input: z.strictObject(pageFields),
    result: page(HostRepositorySchema),
  },
  "reviews.list": {
    permission: "read",
    input: z.strictObject({
      ...pageFields,
      repositoryId: HostIdSchema.optional(),
      state: HostReviewStateSchema.shape.state.optional(),
      includeTrash: z.boolean().optional(),
    }),
    result: page(HostReviewWithSnapshotSchema),
  },
  "review.get": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      reviewVersion: HostVersionSchema.optional(),
    }),
    result: HostReviewWithSnapshotSchema,
  },
  "document.get": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      reviewVersion: HostVersionSchema.optional(),
    }),
    result: HostDocumentStateSchema,
  },
  "document.nodes": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      reviewVersion: HostVersionSchema,
      ids: z
        .array(HostKeySchema)
        .max(HOST_LIMITS.nodes)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Node IDs must be unique.",
        ),
    }),
    result: z.strictObject({
      reviewVersion: HostVersionSchema,
      nodes: z.array(HostNodeSchema).max(HOST_LIMITS.nodes),
    }),
  },
  "document.evidence": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      reviewVersion: HostVersionSchema,
      anchorIds: z
        .array(HostKeySchema)
        .max(HOST_LIMITS.definitions)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Anchor IDs must be unique.",
        ),
    }),
    result: z.strictObject({
      reviewVersion: HostVersionSchema,
      evidence: HostDocumentStateSchema.shape.evidence,
    }),
  },
  "review.history": {
    permission: "read",
    input: z.strictObject({ ...pageFields, reviewId: HostIdSchema }),
    result: page(HostReviewVersionSummarySchema),
  },
  "document.validate": {
    permission: "read",
    input: documentMutation,
    result: HostValidationReportSchema,
  },
} satisfies Record<string, HostOperationDefinition>;
export type HostQueryName = keyof typeof HOST_QUERY_DEFINITIONS;
export type HostQueryInputs = {
  [K in HostQueryName]: z.input<(typeof HOST_QUERY_DEFINITIONS)[K]["input"]>;
};
export type HostQueryResults = {
  [K in HostQueryName]: z.infer<(typeof HOST_QUERY_DEFINITIONS)[K]["result"]>;
};

const addressFields = {
  apiVersion: z.literal(1),
  hostId: HostIdSchema,
  workspaceId: HostIdSchema,
  clientId: HostIdSchema,
};
export const HostEnvelopeSchema = z.strictObject(addressFields);
export type HostEnvelope = z.infer<typeof HostEnvelopeSchema>;
export type HostCommand<K extends HostCommandName = HostCommandName> = {
  [P in K]: HostEnvelope & {
    commandId: string;
    type: P;
    input: HostCommandInputs[P];
  };
}[K];
export type HostQuery<K extends HostQueryName = HostQueryName> = {
  [P in K]: HostEnvelope & { type: P; input: HostQueryInputs[P] };
}[K];

const commandVariants = Object.entries(HOST_COMMAND_DEFINITIONS).map(
  ([name, definition]) =>
    z.strictObject({
      ...addressFields,
      commandId: HostIdSchema,
      type: z.literal(name),
      input: definition.input,
    }),
);
const queryVariants = Object.entries(HOST_QUERY_DEFINITIONS).map(
  ([name, definition]) =>
    z.strictObject({
      ...addressFields,
      type: z.literal(name),
      input: definition.input,
    }),
);
const [firstCommand, ...otherCommands] = commandVariants;
const [firstQuery, ...otherQueries] = queryVariants;
if (!firstCommand || !firstQuery)
  throw new Error("Host operation registries must not be empty.");
// SAFETY: Each variant pairs the literal registry key with that key's input.
// Object.entries erases this correlation; the mapped unions restore it.
export const HostCommandSchema = z.discriminatedUnion("type", [
  firstCommand,
  ...otherCommands,
]) as z.ZodType<HostCommand>;
// SAFETY: Query variants are generated from the same key/input pairs as HostQuery.
export const HostQuerySchema = z.discriminatedUnion("type", [
  firstQuery,
  ...otherQueries,
]) as z.ZodType<HostQuery>;

// Network bodies carry domain intent only. The HTTP adapter supplies the
// authenticated connection context used by the internal command/query types.
export type HostCommandBody = {
  [K in HostCommandName]: Pick<HostCommand<K>, "commandId" | "type" | "input">;
}[HostCommandName];
export type HostQueryBody = {
  [K in HostQueryName]: Pick<HostQuery<K>, "type" | "input">;
}[HostQueryName];
// SAFETY: Omitting only connection fields preserves each registry operation's literal key/input pairing.
export const HostCommandBodySchema = z.discriminatedUnion("type", [
  firstCommand.omit({
    apiVersion: true,
    hostId: true,
    workspaceId: true,
    clientId: true,
  }),
  ...otherCommands.map((schema) =>
    schema.omit({
      apiVersion: true,
      hostId: true,
      workspaceId: true,
      clientId: true,
    }),
  ),
]) as z.ZodType<HostCommandBody>;
// SAFETY: These variants preserve the same operation/input pairing as the internal query union.
export const HostQueryBodySchema = z.discriminatedUnion("type", [
  firstQuery.omit({
    apiVersion: true,
    hostId: true,
    workspaceId: true,
    clientId: true,
  }),
  ...otherQueries.map((schema) =>
    schema.omit({
      apiVersion: true,
      hostId: true,
      workspaceId: true,
      clientId: true,
    }),
  ),
]) as z.ZodType<HostQueryBody>;

export const HostApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "VERSION_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "VALIDATION_FAILED",
    "DEPENDENCY_UNAVAILABLE",
    "INVALID_STATE",
    "RATE_LIMITED",
    "RESOURCE_LIMIT",
    "CURSOR_EXPIRED",
    "INTEGRITY_ERROR",
    "INTERNAL",
  ]),
  message: HostTextSchema,
  retryable: z.boolean(),
  diagnostics: z.array(HostDiagnosticSchema).max(HOST_LIMITS.definitions),
  currentVersion: HostVersionSchema.optional(),
});
export type HostApiError = z.infer<typeof HostApiErrorSchema>;
const failure = z.strictObject({
  ok: z.literal(false),
  error: HostApiErrorSchema,
});
export type HostCommandResponse<K extends HostCommandName> =
  | {
      ok: true;
      data: {
        commandId: string;
        eventCursor: string;
        result: HostCommandResults[K];
      };
    }
  | z.infer<typeof failure>;
export type HostQueryResponse<K extends HostQueryName> =
  | { ok: true; data: { eventCursor: string; result: HostQueryResults[K] } }
  | z.infer<typeof failure>;

export function hostCommandResponseSchema<K extends HostCommandName>(name: K) {
  return z.discriminatedUnion("ok", [
    failure,
    z.strictObject({
      ok: z.literal(true),
      data: z.strictObject({
        commandId: HostIdSchema,
        eventCursor: HostCursorSchema,
        result: HOST_COMMAND_DEFINITIONS[name].result,
      }),
    }),
  ]);
}
export function hostQueryResponseSchema<K extends HostQueryName>(name: K) {
  return z.discriminatedUnion("ok", [
    failure,
    z.strictObject({
      ok: z.literal(true),
      data: z.strictObject({
        eventCursor: HostCursorSchema,
        result: HOST_QUERY_DEFINITIONS[name].result,
      }),
    }),
  ]);
}

export function hostMcpToolName(operation: string): string {
  return `review_${operation.replace(/^review\./, "").replaceAll(".", "_")}`;
}

/** MCP supplies the selected host/workspace and authenticated client envelope. */
export function hostMcpTools() {
  const commands = Object.entries(HOST_COMMAND_DEFINITIONS).map(
    ([operation, definition]) => {
      const inputSchema: z.ZodObject = definition.input;
      return {
        name: hostMcpToolName(operation),
        operation,
        kind: "command",
        inputSchema: z.toJSONSchema(
          inputSchema.extend({ commandId: HostIdSchema }),
          { io: "input" },
        ),
        outputSchema: z.toJSONSchema(definition.result),
        annotations: { readOnlyHint: false, idempotentHint: true },
      };
    },
  );
  const queries = Object.entries(HOST_QUERY_DEFINITIONS).map(
    ([operation, definition]) => ({
      name: hostMcpToolName(operation),
      operation,
      kind: "query",
      inputSchema: z.toJSONSchema(definition.input, { io: "input" }),
      outputSchema: z.toJSONSchema(definition.result),
      annotations: { readOnlyHint: true, idempotentHint: true },
    }),
  );
  const tools = [...commands, ...queries];
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error("Host MCP operation names collide.");
  return tools;
}
