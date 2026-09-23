import type { Readable, Writable } from "node:stream";

import {
  type AuthoringTool,
  callAuthoringTool,
  connectSessionApi,
  toolResultText,
} from "./agent-client.js";
import { SessionApiError } from "./client.js";
import { RECOVERY } from "./mcp.js";

interface AgentCliInput {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
}

export const whiteboardAgentCliHelp =
  "whiteboard api tools\nwhiteboard api <tool-name> '<json>'\nwhiteboard api <tool-name> -  (read JSON from stdin)\nwhiteboard mcp  (stdio MCP adapter; Whiteboard or whiteboard server start must be running)\nSelect headless state with DEV_WHITEBOARD_SERVER_DIR or whiteboard --state-dir <path> api/mcp.\n";

export async function runWhiteboardAgentCli(
  input: AgentCliInput,
): Promise<number> {
  const connect = () => connectSessionApi(input.env);

  try {
    const [mode, ...rest] = input.argv;

    // --json requests raw data for session_get; other tools already return JSON.
    const [name, json, ...extra] = rest.filter(
      (argument) => argument !== "--json",
    );

    if (
      rest.includes("--help") ||
      rest.includes("-h") ||
      (mode === "api" && !name)
    ) {
      input.stdout.write(whiteboardAgentCliHelp);

      return 0;
    }

    if (extra.length || (mode === "mcp" && name))
      throw new Error(`Unexpected arguments. Use whiteboard api --help.`);

    if (mode === "mcp") {
      const { serveWhiteboardMcp } = await import("./mcp.js");
      await serveWhiteboardMcp(
        connect,
        input.stdin ?? process.stdin,
        input.stdout,
        input.stderr,
      );

      return 0;
    }

    let client: Awaited<ReturnType<typeof connect>>;
    let tools: AuthoringTool[];

    try {
      client = await connect();
      tools = await client.read<AuthoringTool[]>("/authoring");
    } catch (error) {
      if (
        name === "session_get_instructions" &&
        !(error instanceof SessionApiError)
      ) {
        input.stderr.write(RECOVERY + "\n");

        return 1;
      }

      throw error;
    }

    if (name === "tools") {
      if (json) throw new Error(`whiteboard api tools takes no input.`);
      input.stdout.write(JSON.stringify(tools, null, 2) + "\n");

      return 0;
    }

    const tool = tools.find((tool) => tool.name === name);

    if (!tool)
      throw new Error(`Unknown tool: ${name}. Use whiteboard api tools.`);
    let source = json ?? "{}";

    if (source === "-") {
      if (!input.stdin) throw new Error("No input stream supplied.");
      source = "";
      input.stdin.setEncoding("utf8");

      for await (const chunk of input.stdin) source += chunk;
    }

    const args = parseJsonText(source);

    if (!isJsonObject(args))
      throw new Error("Tool input must be a JSON object.");

    if (name === `session_get` && rest.includes("--json")) args.format = "json";
    const result = await callAuthoringTool(client, tool, args);
    const text = toolResultText(tool, result);
    input.stdout.write(text.endsWith("\n") ? text : text + "\n");

    return 0;
  } catch (error) {
    input.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    );

    return 1;
  }
}

import { isJsonObject, parseJsonText } from "@dev.fast/json";
