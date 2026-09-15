import type { Writable } from "node:stream";

import { type CliInputStream, findPackageRoot } from "@dev.fast/trace-core";
import { Command, CommanderError } from "commander";

import { readPackageVersion } from "./package-root.js";

export interface RunTracesCliInput {
  argv: string[];
  ownCliPath: string;
  stdin?: CliInputStream;
  stdout: Writable;
  stderr: Writable;
}

export async function runTracesCli(input: RunTracesCliInput): Promise<number> {
  const version = await readPackageVersion(findPackageRoot(import.meta.url));

  const program = new Command().name("dev-traces").version(version);
  program.configureOutput({
    writeOut: (message) => {
      input.stdout.write(message);
    },
    writeErr: (message) => {
      input.stderr.write(message);
    },
  });
  program.exitOverride();

  try {
    await program.parseAsync(input.argv, { from: "user" });

    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
    throw error;
  }
}
