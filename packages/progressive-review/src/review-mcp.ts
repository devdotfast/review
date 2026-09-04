import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  type JsonObject,
  type JsonValue,
  ReviewDocumentFileNameSchema,
  ReviewDocumentFileWriteSchema,
  ReviewDocumentNodeSchema,
  isJsonObject,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import {
  type ReviewCanvasApi,
  ReviewCanvasApiClient,
} from "./review-canvas-api-client";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface RunReviewMcpInput {
  api?: ReviewCanvasApi;
  stdin: Readable;
  stdout: Writable;
}

export async function runReviewMcp(input: RunReviewMcpInput): Promise<number> {
  const api = input.api ?? new ReviewCanvasApiClient();
  const lines = createInterface({ input: input.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: JsonValue;
    try {
      request = parseJsonText(line);
    } catch {
      writeRpc(input.stdout, null, undefined, rpcError(-32700, "Parse error"));
      continue;
    }
    if (!isJsonObject(request)) {
      writeRpc(
        input.stdout,
        null,
        undefined,
        rpcError(-32600, "Invalid request"),
      );
      continue;
    }
    const id = request.id;
    const method = jsonString(request.method);
    if (!method) {
      writeRpc(
        input.stdout,
        rpcId(id),
        undefined,
        rpcError(-32600, "Invalid request"),
      );
      continue;
    }
    if (method.startsWith("notifications/")) continue;
    try {
      const result = await handleMcpRequest(api, method, request.params);
      writeRpc(input.stdout, rpcId(id), result);
    } catch (error) {
      if (method === "tools/call") {
        writeRpc(input.stdout, rpcId(id), {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        });
      } else {
        writeRpc(
          input.stdout,
          rpcId(id),
          undefined,
          rpcError(
            -32602,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
  return 0;
}

async function handleMcpRequest(
  api: ReviewCanvasApi,
  method: string,
  paramsValue: JsonValue | undefined,
): Promise<JsonValue> {
  if (method === "initialize") {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "review-canvas", version: "1.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: REVIEW_MCP_TOOLS };
  if (method !== "tools/call") {
    throw new Error(`Unsupported MCP method: ${method}`);
  }
  const params = requireObject(paramsValue, "params");
  const name = requireString(params, "name");
  const args = requireObject(params.arguments, "arguments");
  const value = await callReviewTool(api, name, args);
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function callReviewTool(
  api: ReviewCanvasApi,
  name: string,
  args: JsonObject,
): Promise<JsonValue> {
  const reviewId = requireString(args, "reviewId");
  if (name === "review_get_document_file") {
    return requireOk(
      await api.getDocumentFile(
        reviewId,
        ReviewDocumentFileNameSchema.parse(args.name),
      ),
    );
  }
  if (name === "review_write_document_file") {
    return requireOk(
      await api.writeDocumentFile(
        reviewId,
        ReviewDocumentFileNameSchema.parse(args.name),
        ReviewDocumentFileWriteSchema.parse({
          source: args.source,
          expectedSourceHash: args.expectedSourceHash,
        }),
      ),
    );
  }
  if (name === "review_get_document") {
    return requireOk(await api.getDocument(reviewId));
  }
  if (name === "review_list_comments") {
    return requireOk(await api.getComments(reviewId));
  }
  if (name === "review_resolve_comment") {
    return requireOk(
      await api.command(reviewId, {
        command: "comment.update",
        mutationId: mutationId(args),
        threadId: requireString(args, "threadId"),
        update: { status: "resolved" },
      }),
    );
  }
  if (name === "review_reply_comment") {
    return requireOk(
      await api.reply({
        reviewId,
        threadId: requireString(args, "threadId"),
        mutationId: mutationId(args),
        messageId: jsonString(args.messageId) ?? randomUUID(),
        body: requireString(args, "body"),
        author: jsonString(args.author),
      }),
    );
  }
  const expectedRevision = requireNonNegativeInteger(args, "expectedRevision");
  const common = {
    mutationId: mutationId(args),
    expectedRevision,
    expectedSourceHash: jsonString(args.expectedSourceHash),
  };
  if (name === "review_replace_document") {
    const nodesValue = args.nodes;
    if (!Array.isArray(nodesValue)) throw new Error("nodes must be an array.");
    return requireOk(
      await api.mutateDocument(reviewId, {
        ...common,
        operation: {
          type: "replace",
          nodes: nodesValue.map((node) => ReviewDocumentNodeSchema.parse(node)),
        },
      }),
    );
  }
  if (name === "review_insert_node") {
    return requireOk(
      await api.mutateDocument(reviewId, {
        ...common,
        operation: {
          type: "insert",
          index: requireNonNegativeInteger(args, "index"),
          node: ReviewDocumentNodeSchema.parse(args.node),
        },
      }),
    );
  }
  if (name === "review_update_node") {
    return requireOk(
      await api.mutateDocument(reviewId, {
        ...common,
        operation: {
          type: "update",
          nodeId: requireString(args, "nodeId"),
          patch: requireObject(args.patch, "patch"),
        },
      }),
    );
  }
  if (name === "review_delete_node") {
    return requireOk(
      await api.mutateDocument(reviewId, {
        ...common,
        operation: {
          type: "delete",
          nodeId: requireString(args, "nodeId"),
        },
      }),
    );
  }
  if (name === "review_move_node") {
    return requireOk(
      await api.mutateDocument(reviewId, {
        ...common,
        operation: {
          type: "move",
          nodeId: requireString(args, "nodeId"),
          index: requireNonNegativeInteger(args, "index"),
        },
      }),
    );
  }
  throw new Error(`Unknown Review tool: ${name}`);
}

function requireOk<T extends { ok: boolean; error?: string }>(
  response: T,
): JsonValue {
  if (!response.ok) throw new Error(response.error ?? "Review API failed.");
  return parseJsonText(JSON.stringify(response));
}

function mutationId(args: JsonObject): string {
  return jsonString(args.mutationId) ?? randomUUID();
}

function requireObject(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  const object = jsonObject(value);
  if (!object) throw new Error(`${label} must be an object.`);
  return object;
}

function requireString(value: JsonObject, key: string): string {
  const string = jsonString(value[key]);
  if (!string?.trim()) throw new Error(`${key} must be a non-empty string.`);
  return string;
}

function requireNonNegativeInteger(value: JsonObject, key: string): number {
  const number = jsonNumber(value[key]);
  if (number === undefined || !Number.isInteger(number) || number < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return number;
}

function rpcId(value: JsonValue | undefined): string | number | null {
  return jsonString(value) ?? jsonNumber(value) ?? null;
}

function rpcError(code: number, message: string): JsonObject {
  return { code, message };
}

function writeRpc(
  stdout: Writable,
  id: string | number | null,
  result?: JsonValue,
  error?: JsonObject,
): void {
  const response: JsonObject = { jsonrpc: "2.0", id };
  if (error) response.error = error;
  else response.result = result ?? null;
  stdout.write(`${JSON.stringify(response)}\n`);
}

const BASE_PROPERTIES = {
  reviewId: { type: "string", format: "uuid" },
  mutationId: { type: "string" },
} as const;

const MUTATION_PROPERTIES = {
  ...BASE_PROPERTIES,
  expectedRevision: { type: "integer", minimum: 0 },
  expectedSourceHash: { type: "string" },
} as const;

const REVIEW_MCP_TOOLS: JsonValue[] = [
  tool(
    "review_get_document_file",
    "Read a rich MDX document input through the API. Returns source and sourceHash; both are null for a missing input.",
    {
      properties: {
        reviewId: BASE_PROPERTIES.reviewId,
        name: { type: "string", enum: ["review.mdx", "data.ts"] },
      },
      required: ["reviewId", "name"],
    },
  ),
  tool(
    "review_write_document_file",
    "Write rich MDX or data.ts using the sourceHash from review_get_document_file (null creates a missing input). Preserves rich components. Publish after editing to compile and present changes. Use node tools for incremental documents.",
    {
      properties: {
        reviewId: BASE_PROPERTIES.reviewId,
        name: { type: "string", enum: ["review.mdx", "data.ts"] },
        source: { type: "string" },
        expectedSourceHash: { type: ["string", "null"] },
      },
      required: ["reviewId", "name", "source", "expectedSourceHash"],
    },
  ),
  tool("review_get_document", "Read the current Review document snapshot.", {
    properties: { reviewId: BASE_PROPERTIES.reviewId },
    required: ["reviewId"],
  }),
  tool(
    "review_replace_document",
    "Replace or initialize stable Review nodes.",
    {
      properties: {
        ...MUTATION_PROPERTIES,
        nodes: { type: "array", items: nodeSchema() },
      },
      required: ["reviewId", "expectedRevision", "nodes"],
    },
  ),
  tool("review_insert_node", "Insert one stable node at an index.", {
    properties: {
      ...MUTATION_PROPERTIES,
      index: { type: "integer", minimum: 0 },
      node: nodeSchema(),
    },
    required: ["reviewId", "expectedRevision", "index", "node"],
  }),
  tool("review_update_node", "Update one node without replacing the canvas.", {
    properties: {
      ...MUTATION_PROPERTIES,
      nodeId: { type: "string" },
      patch: { type: "object" },
    },
    required: ["reviewId", "expectedRevision", "nodeId", "patch"],
  }),
  tool("review_delete_node", "Delete one node by stable ID.", {
    properties: { ...MUTATION_PROPERTIES, nodeId: { type: "string" } },
    required: ["reviewId", "expectedRevision", "nodeId"],
  }),
  tool("review_move_node", "Move one node to a new index.", {
    properties: {
      ...MUTATION_PROPERTIES,
      nodeId: { type: "string" },
      index: { type: "integer", minimum: 0 },
    },
    required: ["reviewId", "expectedRevision", "nodeId", "index"],
  }),
  tool("review_list_comments", "Read Review comment threads.", {
    properties: { reviewId: BASE_PROPERTIES.reviewId },
    required: ["reviewId"],
  }),
  tool("review_resolve_comment", "Resolve a Review comment thread.", {
    properties: {
      ...BASE_PROPERTIES,
      threadId: { type: "string" },
    },
    required: ["reviewId", "threadId"],
  }),
  tool("review_reply_comment", "Reply to a Review comment as the agent.", {
    properties: {
      ...BASE_PROPERTIES,
      threadId: { type: "string" },
      messageId: { type: "string" },
      body: { type: "string" },
      author: { type: "string" },
    },
    required: ["reviewId", "threadId", "body"],
  }),
];

function tool(
  name: string,
  description: string,
  schema: { properties: JsonObject; required: string[] },
): JsonObject {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: schema.properties,
      required: schema.required,
    },
  };
}

function nodeSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["markdown", "callout", "code"] },
      content: { type: "string" },
      title: { type: "string" },
      tone: {
        type: "string",
        enum: ["info", "warning", "success", "danger"],
      },
      language: { type: "string" },
    },
    required: ["id", "kind", "content"],
  };
}
