import type { Readable, Writable } from "node:stream";

import {
  type AuthoringTool,
  callAuthoringTool,
  connectReviewApi,
} from "./agent-client.js";

interface AgentCliInput {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
}

export async function runReviewAgentCli(input: AgentCliInput): Promise<number> {
  try {
    const [mode, name, json, ...extra] = input.argv;

    if (name === "--help" || (mode === "api" && !name)) {
      input.stdout.write(
        "review api tools\nreview api <tool-name> '<json>'\nreview api <tool-name> -  (read JSON from stdin)\nreview mcp  (stdio MCP adapter; Desktop must be running)\n",
      );

      return 0;
    }

    if (extra.length || (mode === "mcp" && name))
      throw new Error("Unexpected arguments. Use review api --help.");

    if (mode === "mcp") {
      const { serveReviewMcp } = await import("./mcp.js");
      await serveReviewMcp(
        () => connectReviewApi(input.env),
        input.stdin ?? process.stdin,
        input.stdout,
      );

      return 0;
    }

    const client = await connectReviewApi(input.env);
    const tools = await client.read<AuthoringTool[]>("/authoring");

    if (name === "tools") {
      if (json) throw new Error("review api tools takes no input.");
      input.stdout.write(JSON.stringify(tools, null, 2) + "\n");

      return 0;
    }

    const tool = tools.find((tool) => tool.name === name);

    if (!tool)
      throw new Error(`Unknown Review tool: ${name}. Use review api tools.`);
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
    const result = await callAuthoringTool(client, tool, args);
    input.stdout.write(JSON.stringify(result) + "\n");

    return 0;
  } catch (error) {
    input.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    );

    return 1;
  }
}

import { isJsonObject, parseJsonText } from "@dev.fast/json";
