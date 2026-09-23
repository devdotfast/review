import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type AuthoringTool,
  callAuthoringTool,
  toolResultText,
} from "./agent-client.js";
import type { SessionApiClient } from "./client.js";

export async function serveWhiteboardMcp(
  connect: () => Promise<SessionApiClient>,
  stdin: Readable,
  stdout: Writable,
  stderr: Writable = process.stderr,
) {
  const server = new Server(
    { name: "whiteboard", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: `Author through the running Whiteboard server. Read session_capabilities before authoring; session_create opens the new session in Desktop when it is available, so call session_open only for an existing session. Dispatch software-map workers only when softwareMapEnabled is true, and name the scratchpad only when scratchpadEnabled is true. Accepted edits are validated and saved immediately. Never read or write Whiteboard files or SQL. Reuse commandId and identical input after a lost response. Use returned target IDs to edit components; there is no expectedVersion or publish step.`,
    },
  );

  // Hosts list tools once, right after initialize, often before Desktop is up.
  // Answer from the last catalog (or none) instead of failing, and announce a
  // changed list once the host can be reached.
  let catalog: AuthoringTool[] = [];
  let announceCatalog = false;

  const load = async (signal?: AbortSignal) => {
    const client = await connect();
    catalog = await client.read<AuthoringTool[]>("/authoring", signal);

    if (announceCatalog) {
      announceCatalog = false;
      void server.sendToolListChanged().catch(() => {});
    }

    return { client, tools: catalog };
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    let tools = catalog;

    try {
      ({ tools } = await load(extra.signal));
    } catch (error) {
      announceCatalog = true;
      stderr.write(
        `whiteboard mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

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
      const { client, tools } = await load(extra.signal);
      const tool = tools.find((tool) => tool.name === request.params.name);

      if (!tool)
        throw new Error(`Unknown Whiteboard tool: ${request.params.name}`);

      const result = await callAuthoringTool(
        client,
        tool,
        request.params.arguments ?? {},
        extra.signal,
      );

      return {
        content: [
          {
            type: "text",
            text: toolResultText(tool, result),
          },
        ],
      };
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
