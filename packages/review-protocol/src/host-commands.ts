import { z } from "zod";

import {
  HostCheckpointSchema,
  HostRepositorySchema,
  HostReviewSchema,
} from "./host-api.js";
import {
  HOST_LIMITS,
  HostChangeSelectorSchema,
  HostDiagnosticSchema,
  HostDocumentCommitSchema,
  HostDocumentOperationSchema,
  HostDocumentSchema,
  HostDocumentStateSchema,
  HostHashSchema,
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
  HOST_RESOURCE_QUERIES,
} from "./host-resources.js";
import { HOST_BINDING_COMMANDS, HOST_SOURCE_QUERIES } from "./host-source.js";

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
  expectedVersion: HostVersionSchema,
});
const documentMutation = z.strictObject({
  reviewId: HostIdSchema,
  expectedDocumentVersion: HostVersionSchema,
  operations: z
    .array(HostDocumentOperationSchema)
    .min(1)
    .max(HOST_LIMITS.operations),
});
export const HostCanvasReportSchema = z.strictObject({
  reviewId: HostIdSchema,
  canvasSessionId: HostIdSchema,
  documentVersion: HostVersionSchema,
  status: z.enum(["rendered", "failed"]),
  visibleNodeIds: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  failures: z
    .array(
      z.strictObject({
        nodeId: HostKeySchema,
        code: HostLabelSchema,
        message: HostTextSchema,
      }),
    )
    .max(HOST_LIMITS.nodes),
});
export type HostCanvasReport = z.infer<typeof HostCanvasReportSchema>;
export const HostCanvasObservationSchema = HostCanvasReportSchema.extend({
  principalId: HostIdSchema,
  receivedAt: HostTimeSchema,
});
export type HostCanvasObservation = z.infer<typeof HostCanvasObservationSchema>;

export const HostPermissionSchema = z.enum([
  "read",
  "author",
  "publish",
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
  ...HOST_BINDING_COMMANDS,
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
    }),
    result: z.strictObject({
      review: HostReviewSchema,
      document: HostDocumentStateSchema,
    }),
  },
  "review.update": {
    permission: "author",
    input: reviewVersion.extend({
      title: HostLabelSchema,
      description: HostTextSchema,
      labels: HostReviewSchema.shape.labels,
    }),
    result: HostReviewSchema,
  },
  "review.close": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewSchema,
  },
  "review.reopen": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewSchema,
  },
  "review.trash": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewSchema,
  },
  "review.restore": {
    permission: "human",
    input: reviewVersion,
    result: HostReviewSchema,
  },
  "document.mutate": {
    permission: "author",
    input: documentMutation,
    result: HostDocumentCommitSchema,
  },
  "document.replace": {
    permission: "author",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedDocumentVersion: HostVersionSchema,
      document: HostDocumentSchema,
    }),
    result: HostDocumentCommitSchema,
  },
  "document.restore": {
    permission: "author",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedDocumentVersion: HostVersionSchema,
      fromVersion: HostVersionSchema,
    }),
    result: HostDocumentCommitSchema,
  },
  "review.publish": {
    permission: "publish",
    input: z.strictObject({
      reviewId: HostIdSchema,
      expectedDocumentVersion: HostVersionSchema,
      expectedReviewVersion: HostVersionSchema,
      mapVersions: HostCheckpointSchema.shape.mapVersions,
    }),
    result: HostCheckpointSchema,
  },
  "canvas.report": {
    permission: "read",
    input: HostCanvasReportSchema,
    result: z.strictObject({ accepted: z.literal(true) }),
  },
} satisfies Record<string, HostOperationDefinition>;
export type HostCommandName = keyof typeof HOST_COMMAND_DEFINITIONS;
export type HostCommandInputs = {
  [K in HostCommandName]: z.infer<
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
export const HostCapabilitiesSchema = z.strictObject({
  apiVersions: z.array(z.number().int().positive()).max(10),
  documentSchemaVersions: z.array(z.number().int().positive()).max(10),
  nodeTypes: z.array(HostNodeTypeSchema).max(100),
  limits: z.strictObject(
    Object.fromEntries(
      Object.keys(HOST_LIMITS).map((key) => [
        key,
        z.number().int().nonnegative(),
      ]),
    ),
  ),
  commands: z.array(operationName).max(500),
  queries: z.array(operationName).max(500),
  rendererVersion: z.string().min(1).max(100),
  source: z.strictObject({ read: z.boolean(), navigation: z.boolean() }),
  ask: z.strictObject({
    available: z.boolean(),
    supportedHarnesses: z
      .array(z.enum(["claude-code", "codex", "opencode", "pi"]))
      .max(4),
    isolation: z.literal("trusted_local"),
  }),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export const HOST_QUERY_DEFINITIONS = {
  ...HOST_SOURCE_QUERIES,
  ...HOST_RESOURCE_QUERIES,
  ...HOST_FEEDBACK_QUERIES,
  "canvas.reports": {
    permission: "read",
    input: z.strictObject({ reviewId: HostIdSchema }),
    result: z.array(HostCanvasObservationSchema).max(20),
  },
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
      workflow: HostReviewSchema.shape.workflow.optional(),
      includeTrash: z.boolean().optional(),
    }),
    result: page(HostReviewSchema),
  },
  "review.get": {
    permission: "read",
    input: z.strictObject({ reviewId: HostIdSchema }),
    result: z.strictObject({ review: HostReviewSchema }),
  },
  "document.get": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      version: HostVersionSchema.optional(),
    }),
    result: HostDocumentStateSchema,
  },
  "document.nodes": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      version: HostVersionSchema,
      ids: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
    }),
    result: z.strictObject({
      version: HostVersionSchema,
      nodes: z.array(HostNodeSchema).max(HOST_LIMITS.nodes),
    }),
  },
  "document.evidence": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      version: HostVersionSchema,
      anchorIds: z.array(HostKeySchema).max(HOST_LIMITS.definitions),
    }),
    result: z.strictObject({
      version: HostVersionSchema,
      evidence: HostDocumentStateSchema.shape.evidence,
    }),
  },
  "document.history": {
    permission: "read",
    input: z.strictObject({ ...pageFields, reviewId: HostIdSchema }),
    result: page(
      z.strictObject({
        version: HostVersionSchema,
        contentHash: HostHashSchema,
        createdAt: HostTimeSchema,
      }),
    ),
  },
  "document.validate": {
    permission: "read",
    input: documentMutation,
    result: HostValidationReportSchema,
  },
  "checkpoints.list": {
    permission: "read",
    input: z.strictObject({ ...pageFields, reviewId: HostIdSchema }),
    result: page(HostCheckpointSchema),
  },
  "checkpoint.get": {
    permission: "read",
    input: z.strictObject({
      reviewId: HostIdSchema,
      checkpointId: HostIdSchema,
    }),
    result: z.strictObject({
      checkpoint: HostCheckpointSchema,
      document: HostDocumentStateSchema,
    }),
  },
} satisfies Record<string, HostOperationDefinition>;
export type HostQueryName = keyof typeof HOST_QUERY_DEFINITIONS;
export type HostQueryInputs = {
  [K in HostQueryName]: z.infer<(typeof HOST_QUERY_DEFINITIONS)[K]["input"]>;
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
    "UNSUPPORTED_VERSION",
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
