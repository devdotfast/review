import type { Readable, Writable } from "node:stream";

import { isStringValue } from "@dev.fast/json";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type AuthoringTool,
  TEXT_TOOLS,
  callAuthoringTool,
} from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import type { ReviewApiClient } from "./client.js";
import { ReviewApiError } from "./client.js";
import { RECOVERY } from "./recovery.js";

const INSTRUCTIONS_TOOL = authoringTools().find(
  (tool) => tool.name === "review_get_instructions",
)!;

export async function serveReviewMcp(
  connect: () => Promise<ReviewApiClient>,
  stdin: Readable,
  stdout: Writable,
  stderr: Writable = process.stderr,
) {
  const server = new Server(
    { name: "review", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        'Review explains code in documents the user reads in Review Desktop. Call review_get_instructions before creating or editing a Review and follow it. Read review_capabilities before authoring; call review_open only when desktopAvailable is true, and generate software maps only when softwareMapEnabled is true. Unless the user explicitly asks for the scratchpad, requests to create or write a Review, or to use Review to explain something and open it, mean a regular Review document: start with review_get_instructions({topic:"authoring"}), even when the scratchpad is enabled. Regular Reviews can explain architecture without reviewing a diff. For an explicit scratchpad request or an informal "show me how" explanation without a Review request, call review_capabilities; if it reports scratchpadEnabled and desktopAvailable in interactive mode, draw the explanation on the Review scratchpad rather than answering only in chat, starting with review_get_instructions({topic:"scratchpad"}). For why code exists, what an agent was thinking, or whether an agent solved something before, call review_get_instructions({topic:"trace-archaeology"}). Never read or write Review files or SQL.',
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
        `review mcp: ${error instanceof Error ? error.message : String(error)}\n`,
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
      let client: ReviewApiClient;
      let tools: AuthoringTool[];

      try {
        ({ client, tools } = await load(extra.signal));
      } catch (error) {
        announceCatalog = true;

        if (
          request.params.name === INSTRUCTIONS_TOOL.name &&
          !(error instanceof ReviewApiError)
        )
          return { content: [{ type: "text" as const, text: RECOVERY }] };

        throw error;
      }

      const tool = tools.find((tool) => tool.name === request.params.name);

      if (!tool) throw new Error(`Unknown Review tool: ${request.params.name}`);

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
            text:
              TEXT_TOOLS.has(tool.name) && isStringValue(result)
                ? result
                : JSON.stringify(result),
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
