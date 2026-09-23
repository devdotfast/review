import type { Readable, Writable } from "node:stream";

import { isStringValue } from "@dev.fast/json";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import type { ReviewApiClient } from "./client.js";
import { ReviewApiError } from "./client.js";

const INSTRUCTIONS_TOOL = authoringTools().find(
  (tool) => tool.name === "review_get_instructions",
)!;

export const RECOVERY =
  "Review is not running, so its tools and guidance are unavailable. Start Review Desktop (or `review server start` for headless use). If Review's tools still do not appear, reconnect the Review MCP server or start a new agent session.";

export async function serveReviewMcp(
  connect: () => Promise<ReviewApiClient>,
  stdin: Readable,
  stdout: Writable,
  stderr: Writable = process.stderr,
) {
  // Initialization is served once. Give a reachable host a short chance to
  // supply its capability-specific prompt without delaying offline startup.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const initialTools = await Promise.race([
    connect()
      .then((client) =>
        client.read<AuthoringTool[]>("/authoring", controller.signal),
      )
      .catch(() => []),
    new Promise<AuthoringTool[]>((resolve) => {
      timer = setTimeout(() => resolve([]), 300);
    }),
  ]);

  clearTimeout(timer);
  controller.abort();

  const initialInstructions =
    initialTools.find((tool) => tool.name === INSTRUCTIONS_TOOL.name) ??
    INSTRUCTIONS_TOOL;

  const server = new Server(
    { name: "review", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: `Review explains code in documents the user reads in Review Desktop. Call review_get_instructions before creating or editing a Review and follow it. ${initialInstructions.description} Read review_capabilities before authoring; call review_open only when desktopAvailable is true, and generate software maps only when softwareMapEnabled is true. Never read or write Review files or SQL.`,
    },
  );

  // Hosts list tools once, right after initialize, often before Desktop is up.
  // Answer from the last catalog (or none) instead of failing, and announce a
  // changed list once the host can be reached.
  let catalog: AuthoringTool[] = initialTools;
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
              (tool.name === "review_get" ||
                tool.name === INSTRUCTIONS_TOOL.name) &&
              isStringValue(result)
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
