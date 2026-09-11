import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  type JsonValue,
  ReviewThreadsCommandSchema,
  isJsonObject,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { resolveAuthoringSessionRef } from "./authoring-session";
import { requestReviewLifecycle } from "./review-lifecycle-client";
import {
  ReviewDocumentFileNameSchema,
  ReviewDocumentFileWriteSchema,
  ReviewLifecycleTargetSchema,
  ReviewListRequestSchema,
  ReviewMetadataUpdateSchema,
  ReviewPublishRequestSchema,
  ReviewRebindRequestSchema,
  ReviewScaffoldRequestSchema,
} from "./review-lifecycle-contracts";

const reviewTarget = z.strictObject({ reviewUuid: z.uuid() });

const tools = [
  {
    name: "review_create",
    description: "Create or update a Review bound to a source checkout.",
    path: "/lifecycle/scaffold",
    schema: ReviewScaffoldRequestSchema,
    agent: true,
  },
  {
    name: "review_list",
    description: "List Reviews owned by the desktop.",
    path: "/lifecycle/list",
    schema: ReviewListRequestSchema,
  },
  {
    name: "review_get",
    description: "Read a Review's metadata and pinned source revisions.",
    path: "/lifecycle/resolve",
    schema: ReviewLifecycleTargetSchema,
  },
  {
    name: "review_update_metadata",
    description:
      "Change the title, checking the previously read title for conflicts.",
    path: "/lifecycle/metadata",
    schema: ReviewMetadataUpdateSchema.extend({ reviewUuid: z.uuid() }),
  },
  {
    name: "review_rebind",
    description: "Move a Review to a different source change.",
    path: "/lifecycle/rebind",
    schema: ReviewRebindRequestSchema,
    agent: true,
  },
  {
    name: "review_publish",
    description: "Validate, seal, and present the Review document.",
    path: "/lifecycle/publish",
    schema: ReviewPublishRequestSchema,
    agent: true,
  },
  {
    name: "review_get_document_file",
    description:
      "Read review.mdx or data.ts and its source hash through the desktop.",
    path: "/lifecycle/document/read",
    schema: reviewTarget.extend({ name: ReviewDocumentFileNameSchema }),
  },
  {
    name: "review_write_document_file",
    description:
      "Replace Review source using the hash from the last read. Publish to present the changes.",
    path: "/lifecycle/document/write",
    schema: ReviewDocumentFileWriteSchema.extend({ reviewUuid: z.uuid() }),
  },
  {
    name: "review_list_comments",
    description: "Read submitted comments and pending drafts.",
    path: "/lifecycle/threads/snapshot",
    schema: reviewTarget,
  },
  {
    name: "review_comment_command",
    description:
      "Create, update, or remove comments and drafts through the Review's shared service.",
    path: "/lifecycle/threads/command",
    schema: reviewTarget.extend({ command: ReviewThreadsCommandSchema }),
  },
  {
    name: "review_reply_comment",
    description: "Save an agent answer to a comment thread.",
    path: "/lifecycle/threads/reply",
    schema: reviewTarget.extend({
      mutationId: z.uuid(),
      threadId: z.string().min(1),
      messageId: z.uuid(),
      author: z.string().trim().min(1),
      body: z.string().trim().min(1),
      format: z.enum(["plain", "markdown"]),
    }),
  },
];

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
});

const callSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.json()).default({}),
});

/** Stdio transport only: the desktop owns validation, storage, and publication. */
export async function runReviewMcp(input: {
  stdin: Readable;
  stdout: Writable;
  request?: typeof requestReviewLifecycle;
}): Promise<number> {
  const lines = createInterface({ input: input.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let value: JsonValue;

    try {
      value = parseJsonText(line);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    const parsed = requestSchema.safeParse(value);

    if (!parsed.success) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      });
      continue;
    }

    const request = parsed.data;

    if (request.id === undefined) continue;

    try {
      let result: JsonValue;

      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "review", version: "1.0.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: tools.map(({ name, description, schema }) => ({
              name,
              description,
              inputSchema: jsonObject(
                parseJsonText(JSON.stringify(z.toJSONSchema(schema))),
              )!,
            })),
          };
          break;
        case "tools/call": {
          const call = callSchema.parse(request.params);
          const tool = tools.find((entry) => entry.name === call.name);

          if (!tool) throw new Error(`Unknown Review tool: ${call.name}`);

          const agent = tool.agent
            ? resolveAuthoringSessionRef(process.env)
            : undefined;

          if (agent && call.arguments.agent === undefined)
            call.arguments.agent = {
              harness: agent.harness,
              sessionId: agent.sessionId,
            };
          const args = tool.schema.parse(call.arguments);

          const data = await (input.request ?? requestReviewLifecycle)(
            tool.path,
            args,
          );

          result = { content: [{ type: "text", text: JSON.stringify(data) }] };

          if (isJsonObject(data)) {
            result.structuredContent = data;

            if (data.ok === false) result.isError = true;
          }

          break;
        }

        default:
          write({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          });
          continue;
      }

      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(
        request.method === "tools/call"
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                content: [{ type: "text", text: message }],
                isError: true,
              },
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32602, message },
            },
      );
    }
  }

  return 0;

  function write(value: JsonValue) {
    input.stdout.write(`${JSON.stringify(value)}\n`);
  }
}
