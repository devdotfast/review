import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import type { ReviewApiClient } from "./client.js";

export async function serveReviewMcp(
  connect: () => Promise<ReviewApiClient>,
  stdin: Readable,
  stdout: Writable,
) {
  const server = new Server(
    { name: "review", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Author through Review Desktop. Accepted edits are validated and saved immediately. Never read or write Review files or SQL. Reuse commandId and identical input after a lost response. Use returned target IDs to edit components; there is no expectedVersion or publish step.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await connect();
    const tools = await client.read<AuthoringTool[]>("/authoring");

    return {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const client = await connect();

      const tools = await client.read<AuthoringTool[]>(
        "/authoring",
        extra.signal,
      );

      const tool = tools.find((tool) => tool.name === request.params.name);

      if (!tool) throw new Error(`Unknown Review tool: ${request.params.name}`);

      const result = await callAuthoringTool(
        client,
        tool,
        request.params.arguments ?? {},
        extra.signal,
      );

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport(stdin, stdout));

  return server;
}
