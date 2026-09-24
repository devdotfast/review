import type { Readable, Writable } from "node:stream";

import { traceMachineEnabled } from "@dev.fast/trace-core";

import {
  REVIEW_INSTANCE_ENV,
  selectReviewInstance,
} from "../desktop-discovery.js";
import { devReviewHome } from "../review-home-paths.js";
import {
  type AuthoringTool,
  connectReviewApi,
  connectReviewInstance,
  toolResultText,
} from "./agent-client.js";
import { type ReviewApiClient, ReviewApiError } from "./client.js";
import { callPublicTool, publicTool } from "./public-tools.js";
import { RECOVERY } from "./recovery.js";

interface AgentCliInput {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
}

export const reviewAgentCliHelp =
  "whiteboard api tools\nwhiteboard api <tool-name> '<json>'\nwhiteboard api <tool-name> -  (read JSON from stdin)\nwhiteboard mcp  (stdio MCP adapter; Whiteboard Desktop or whiteboard server start must be running)\nSelect headless state with DEV_REVIEW_SERVER_DIR or whiteboard --state-dir <path> api/mcp.\n";

export async function runReviewAgentCli(input: AgentCliInput): Promise<number> {
  const env = input.env ?? process.env;

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
      input.stdout.write(reviewAgentCliHelp);

      return 0;
    }

    if (extra.length || (mode === "mcp" && name))
      throw new Error("Unexpected arguments. Use whiteboard api --help.");

    if (mode === "mcp") {
      const { serveReviewMcp } = await import("./mcp.js");
      await serveReviewMcp(
        (key) =>
          connectReviewInstance(
            key ? { ...env, [REVIEW_INSTANCE_ENV]: key } : env,
          ),
        input.stdin ?? process.stdin,
        input.stdout,
        input.stderr,
        await traceMachineEnabled({ env: input.env }),
        env.DEV_REVIEW_SERVER_DIR?.trim()
          ? undefined
          : async (problem) => {
              const selection = await selectReviewInstance({ env });

              return {
                key: selection.key,
                selectedBy: selection.source,
                desktopAvailable: false,
                running: selection.instances
                  .filter((instance) => instance.healthy)
                  .map((instance) => instance.key),
                home: devReviewHome(env),
                problem,
              };
            },
      );

      return 0;
    }

    let client: ReviewApiClient;
    let tools: AuthoringTool[];

    try {
      client = await connectReviewApi(input.env);
      tools = (await client.read<AuthoringTool[]>("/authoring")).map(
        publicTool,
      );
    } catch (error) {
      if (
        name === "session_get_instructions" &&
        !(error instanceof ReviewApiError)
      ) {
        input.stderr.write(RECOVERY + "\n");

        return 1;
      }

      throw error;
    }

    if (name === "tools") {
      if (json) throw new Error("whiteboard api tools takes no input.");
      input.stdout.write(JSON.stringify(tools, null, 2) + "\n");

      return 0;
    }

    const tool = tools.find((tool) => tool.name === name);

    if (!tool)
      throw new Error(
        `Unknown Review tool: ${name}. Use whiteboard api tools.`,
      );
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

    if (name === "session_get" && rest.includes("--json")) args.format = "json";
    const result = await callPublicTool(client, tool, args);
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
