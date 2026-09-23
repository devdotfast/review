import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";

export const renameNotice = {
  code: "review_renamed",
  error:
    "Review is now Whiteboard. Use the whiteboard command, /whiteboard skill, and /sessions-api endpoints. Reconnect MCP with whiteboard mcp and use session_* tools with sessionId. This request was not executed.",
  replacement: {
    command: "whiteboard",
    api: "/sessions-api",
    mcp: "whiteboard mcp",
    skill: "/whiteboard",
  },
};

/** Retired HTTP requests must never reach the store or a mutation handler. */
export function legacyWhiteboardApi() {
  return new Hono().all("*", (context) => context.json(renameNotice, 410));
}

/** Keep cached MCP calls intelligible without forwarding any old operations. */
export async function serveLegacyWhiteboardMcp(
  stdin: Readable,
  stdout: Writable,
) {
  const server = new Server(
    { name: "review", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: renameNotice.error,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "review_migration",
        description: renameNotice.error,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(renameNotice) }],
  }));
  await server.connect(new StdioServerTransport(stdin, stdout));

  return server;
}

export async function runLegacyWhiteboardCli(
  argv: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
) {
  if (argv[0] === "mcp") {
    await serveLegacyWhiteboardMcp(stdin, stdout);

    return 0;
  }

  if (argv.includes("--json") || argv[0] === "api")
    stdout.write(`${JSON.stringify(renameNotice)}\n`);
  else stderr.write(`${renameNotice.error}\n`);

  return 1;
}
