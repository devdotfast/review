import path from "node:path";
import type { Writable } from "node:stream";

import {
  traceHomeDir,
  traceMachineEnabled,
  traceScope,
} from "@dev.fast/trace-core";
import { Command, CommanderError, Option } from "commander";

import { isOwnedShim, pathShimPath } from "./cli-install";
import { connectPrompt } from "./connect-prompts";
import { ALL_INSTALL_TARGETS, type InstallTarget } from "./install";

export async function runMcpInstallInstructions(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const command = new Command("whiteboard mcp install-instructions")
    .description(
      "Print agent setup instructions without starting an MCP server",
    )
    .addOption(
      new Option("--harness <name>", "coding agent")
        .choices(ALL_INSTALL_TARGETS)
        .makeOptionMandatory(),
    )
    .option("--json", "print instructions as JSON")
    .configureOutput({
      writeOut: (text) => input.stdout.write(text),
      writeErr: (text) => input.stderr.write(text),
    })
    .exitOverride()
    .action(async (options: { harness: InstallTarget; json?: boolean }) => {
      const env = input.env ?? process.env;

      const { homeDir, devHome } = traceScope({
        env,
        homeDir: traceHomeDir(env),
      });

      const instructions = connectPrompt(options.harness, {
        hasShim: await isOwnedShim(pathShimPath(homeDir)),
        traceEnabled: await traceMachineEnabled({ homeDir, env }),
        fffBinaryPath: path.join(homeDir, ".local", "bin", "fff-mcp"),
        fffCorpusRoot: path.join(devHome, "trace-search"),
      });

      input.stdout.write(
        (options.json
          ? JSON.stringify({ harness: options.harness, instructions })
          : instructions) + "\n",
      );
    });

  try {
    await command.parseAsync(input.argv, { from: "user" });

    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
