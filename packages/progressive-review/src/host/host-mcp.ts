import type { Readable, Writable } from "node:stream";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_LIMITS,
  HOST_QUERY_DEFINITIONS,
  HOST_RESOURCE_LIMITS,
  HostIdSchema,
  hostMcpTools,
} from "@dev.fast/review-protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  isHostCommandName,
  isHostQueryName,
  parseHostClientFlags,
} from "./host-cli";
import { LocalHostClient, describeHostClientError } from "./host-discovery";

interface HostMcpOptions {
  argv: string[];
  stdin: Readable;
  stdout: Writable;
  stderr: Pick<Writable, "write">;
  env?: NodeJS.ProcessEnv;
}

/** MCP is only an adapter: operation schemas, permissions and persistence all
 * belong to the host. The SDK owns initialization, framing and JSON-RPC. */
export async function runHostMcp(options: HostMcpOptions): Promise<number> {
  try {
    return await serveHostMcp(options);
  } catch (error) {
    const detail =
      error instanceof Error
        ? describeHostClientError(error)
        : {
            code: "INTERNAL",
            message: "The Review MCP client could not start.",
          };
    options.stderr.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
    return 1;
  }
}

async function serveHostMcp(options: HostMcpOptions): Promise<number> {
  const flags = parseHostClientFlags(options.argv, ["client-id"]);
  const client = new LocalHostClient({
    env: options.env,
    clientId: flags["client-id"],
  });
  const tools = hostMcpTools();
  const server = new Server(
    { name: "review-host", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Author Review through these host operations. Commands require a fresh commandId UUID; reuse that same ID and input if the response is lost. Queries expose canonical state. Never read or write Review files or SQL. Publication is explicit. Review Desktop must already be running.",
    },
  );
  const transport = new StdioServerTransport(options.stdin, options.stdout, {
    maxBufferSize: HOST_RESOURCE_LIMITS.assetUploadRequestBytes + 64 * 1024,
  });
  const openInput = z.strictObject({ reviewId: HostIdSchema });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const capabilities = (await client.query("capabilities", {})).result;
      return {
        tools: [
          ...tools
            .filter((tool) =>
              (tool.kind === "command"
                ? capabilities.commands
                : capabilities.queries
              ).includes(tool.operation),
            )
            .map((tool) =>
              ToolSchema.parse({
                name: tool.name,
                inputSchema: tool.inputSchema,
                // MCP requires an object root even when the domain query
                // legitimately returns an array (for example canvas reports).
                outputSchema:
                  tool.outputSchema.type === "object"
                    ? tool.outputSchema
                    : {
                        type: "object",
                        properties: { result: tool.outputSchema },
                        required: ["result"],
                        additionalProperties: false,
                      },
                annotations: tool.annotations,
                description: `${tool.operation} (${tool.kind}).${tool.kind === "command" ? " Supply a commandId UUID and reuse it for retries." : ""}`,
              }),
            ),
          ...(capabilities.commands.includes("review.create") ||
          capabilities.commands.includes("review.attention")
            ? [
                ToolSchema.parse({
                  name: "review_open",
                  description:
                    "Show a review in the running Desktop. This changes window selection, not review content.",
                  inputSchema: z.toJSONSchema(openInput),
                  outputSchema: z.toJSONSchema(
                    z.strictObject({ opened: z.literal(true) }),
                  ),
                  annotations: {
                    readOnlyHint: false,
                    idempotentHint: true,
                    destructiveHint: false,
                  },
                }),
              ]
            : []),
        ],
      };
    } catch (error) {
      const detail =
        error instanceof Error ? describeHostClientError(error) : undefined;
      throw new McpError(
        ErrorCode.InternalError,
        detail?.message ?? "The Review host is unavailable.",
      );
    }
  });
  let active = 0;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (active >= 8)
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Too many concurrent Review operations.",
      );
    active++;
    let commandId: string | undefined;
    try {
      if (request.params.name === "review_open") {
        const input = openInput.parse(request.params.arguments);
        const result = await client.open(input.reviewId, extra.signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      const tool = tools.find((entry) => entry.name === request.params.name);
      if (!tool)
        throw new McpError(ErrorCode.InvalidParams, "Unknown Review tool.");
      const args = request.params.arguments ?? {};
      const limit =
        tool.operation === "asset.upload"
          ? HOST_RESOURCE_LIMITS.assetUploadRequestBytes
          : HOST_LIMITS.commandBytes;
      if (Buffer.byteLength(JSON.stringify(args)) > limit)
        throw new McpError(
          ErrorCode.InvalidParams,
          "The input exceeds this Review operation's byte limit.",
        );
      if (tool.kind === "command" && isHostCommandName(tool.operation)) {
        const input = HOST_COMMAND_DEFINITIONS[tool.operation].input
          .extend({ commandId: HostIdSchema })
          .parse(args);
        const { commandId: receipt, ...body } = input;
        commandId = receipt;
        // Parsing with the operation schema restores its input shape after
        // removing the MCP-only receipt ID. No contract is duplicated here.
        const operationInput =
          HOST_COMMAND_DEFINITIONS[tool.operation].input.parse(body);
        const data = await client.command(tool.operation, operationInput, {
          commandId,
          signal: extra.signal,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent:
            tool.outputSchema.type === "object"
              ? { ...data.result }
              : { result: data.result },
          _meta: { commandId: data.commandId, eventCursor: data.eventCursor },
        };
      }
      if (tool.kind === "query" && isHostQueryName(tool.operation)) {
        const input = HOST_QUERY_DEFINITIONS[tool.operation].input.parse(args);
        const data = await client.query(tool.operation, input, extra.signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent:
            tool.outputSchema.type === "object"
              ? { ...data.result }
              : { result: data.result },
          _meta: { eventCursor: data.eventCursor },
        };
      }
      throw new McpError(ErrorCode.InvalidParams, "Unknown Review operation.");
    } catch (error) {
      if (error instanceof McpError) throw error;
      const detail =
        error instanceof Error
          ? describeHostClientError(error)
          : {
              code: "INTERNAL",
              message: "The Review client failed unexpectedly.",
              retryable: false,
              diagnostics: [],
            };
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, error: detail, commandId }),
          },
        ],
      };
    } finally {
      active--;
    }
  });
  return new Promise<number>((resolve, reject) => {
    let exitCode = 0;
    const close = () => {
      void server.close();
    };
    server.onerror = () => {
      exitCode = 1;
      options.stderr.write(
        "Review MCP received an invalid or oversized protocol message.\n",
      );
    };
    server.onclose = () => {
      options.stdin.off("end", close);
      resolve(exitCode);
    };
    options.stdin.once("end", close);
    void server.connect(transport).catch(reject);
  });
}
