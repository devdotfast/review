import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ReviewToolCall } from "../review-telemetry.js";
import { type AuthoringTool, toolResultText } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import type { ReviewApiClient } from "./client.js";
import { ReviewApiError } from "./client.js";
import { callPublicTool, publicTool } from "./public-tools.js";
import { RECOVERY } from "./recovery.js";

// Some hosts ignore tools/list_changed, so the agent itself has to reload.
const RELOAD_TOOLS =
  "Whiteboard is running now, but this session listed Whiteboard's tools before it started, so you may see only session_get_instructions. Before authoring, reload the `whiteboard` MCP server's tools (reconnect it in your agent, or start a new agent session). If you can already see tools such as session_create, carry on.";

export function mcpServerInstructions(context: {
  scratchpadAvailable: boolean;
  traceEnabled: boolean;
}): string {
  return [
    "Whiteboard explains code in documents the user reads in Whiteboard Desktop. Call session_get_instructions before creating or editing a Whiteboard and follow it. Read session_capabilities before authoring; session_create opens the new review in Desktop when it is available, so call session_open only for an existing review, and generate software maps only when softwareMapEnabled is true. When the user asks for a Whiteboard or to use Whiteboard (for example to review a branch, a change or a pull request, or to explain a system in Whiteboard), author a Whiteboard with the default topic.",
    ...(context.scratchpadAvailable
      ? [
          'When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, call session_capabilities; if it reports scratchpadEnabled and desktopAvailable, draw on the Whiteboard scratchpad rather than answering only in chat, starting with session_get_instructions({topic:"scratchpad"}).',
        ]
      : []),
    ...(context.traceEnabled
      ? [
          'For why code exists, what an agent was thinking, or whether an agent solved something before, call session_get_instructions({topic:"trace-archaeology"}).',
        ]
      : []),
    "Never read or write Whiteboard files or SQL. Reuse commandId and identical input after a lost response.",
  ].join(" ");
}

export async function serveReviewMcp(
  connect: () => Promise<ReviewApiClient>,
  stdin: Readable,
  stdout: Writable,
  stderr: Writable = process.stderr,
  traceEnabled = false,
  onToolCall?: (call: ReviewToolCall) => void,
) {
  const instructionsTool = {
    ...authoringTools(false, traceEnabled).find(
      (tool) => tool.name === "review_get_instructions",
    )!,
    name: "session_get_instructions",
  };

  const server = new Server(
    { name: "whiteboard", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
      // Initialize comes before Desktop can be asked; the scratchpad
      // sentence defers to session_capabilities.
      instructions: mcpServerInstructions({
        scratchpadAvailable: true,
        traceEnabled,
      }),
    },
  );

  // Hosts list tools once, right after initialize, often before Desktop is up.
  // Answer from the last catalog (or none) instead of failing, and announce a
  // changed list once the host can be reached.
  let catalog: AuthoringTool[] = [];
  let announceCatalog = false;
  let listedWhileDown = false;

  const load = async (signal?: AbortSignal) => {
    const client = await connect();
    catalog = (await client.read<AuthoringTool[]>("/authoring", signal)).map(
      publicTool,
    );

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
      listedWhileDown = false;
    } catch (error) {
      announceCatalog = true;
      listedWhileDown = true;
      stderr.write(
        `whiteboard mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    return {
      tools: [
        tools.find((tool) => tool.name === instructionsTool.name) ??
          instructionsTool,
        ...tools.filter((tool) => tool.name !== instructionsTool.name),
      ].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const startedAt = Date.now();
    // The requested name is agent input; only a catalog name is reported.
    let tool: AuthoringTool | undefined;

    const report = (ok: boolean) =>
      onToolCall?.({
        tool: tool?.name ?? "other",
        via: "mcp",
        ok,
        durationMs: Date.now() - startedAt,
      });

    try {
      let client: ReviewApiClient;
      let tools: AuthoringTool[];

      try {
        ({ client, tools } = await load(extra.signal));
      } catch (error) {
        announceCatalog = true;

        if (
          request.params.name === instructionsTool.name &&
          !(error instanceof ReviewApiError)
        )
          return { content: [{ type: "text" as const, text: RECOVERY }] };

        throw error;
      }

      tool = tools.find((tool) => tool.name === request.params.name);

      if (!tool)
        throw new Error(`Unknown Whiteboard tool: ${request.params.name}`);

      const result = await callPublicTool(
        client,
        tool,
        request.params.arguments ?? {},
        extra.signal,
      );

      const text = toolResultText(tool, result);
      report(true);

      return {
        content: [
          {
            type: "text",
            text:
              listedWhileDown && tool.name === instructionsTool.name
                ? `${RELOAD_TOOLS}\n\n${text}`
                : text,
          },
        ],
      };
    } catch (error) {
      report(false);

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
