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
import { SessionApiError } from "./client.js";
import { authoringTools } from "./authoring-tools.js";
import { RECOVERY } from "./recovery.js";

const INSTRUCTIONS_TOOL = authoringTools().find(
  (tool) => tool.name === "session_get_instructions",
)!;

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
      instructions:
        'Whiteboard explains code in sessions the user reads in Whiteboard Desktop. Call session_get_instructions before authoring and follow it. Read session_capabilities before authoring. When the user asks to see how code works or wants a diagram, and session_capabilities reports authoringMode interactive, desktopAvailable true, and scratchpadEnabled true, call session_get_instructions({topic:"scratchpad"}) instead of drawing ASCII in chat. For why code exists or whether an agent solved something before, call session_get_instructions({topic:"trace-archaeology"}). Never read or write Whiteboard files or SQL.',
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
      tools: [
        tools.find((tool) => tool.name === INSTRUCTIONS_TOOL.name) ??
          INSTRUCTIONS_TOOL,
        ...tools.filter((tool) => tool.name !== INSTRUCTIONS_TOOL.name),
      ].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      let client: SessionApiClient;
      let tools: AuthoringTool[];

      try {
        ({ client, tools } = await load(extra.signal));
      } catch (error) {
        announceCatalog = true;

        if (
          request.params.name === INSTRUCTIONS_TOOL.name &&
          !(error instanceof SessionApiError)
        )
          return { content: [{ type: "text" as const, text: RECOVERY }] };

        throw error;
      }

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
