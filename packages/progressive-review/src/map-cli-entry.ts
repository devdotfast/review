#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runProgressiveReviewCli } from "./cli-runner";
import { runSoftwareMapCli } from "./map-cli";

export interface SoftwareMapCliEntryInput {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  runSoftwareMapCli?: typeof runSoftwareMapCli;
}

export async function runSoftwareMapCliEntry(
  input: SoftwareMapCliEntryInput,
): Promise<number> {
  return runProgressiveReviewCli({
    argv: ["map", ...input.args],
    cwd: input.cwd,
    env: input.env,
    stdout: input.stdout,
    stderr: input.stderr,
    runtime: input.runSoftwareMapCli
      ? { runSoftwareMapCli: input.runSoftwareMapCli }
      : undefined,
  });
}

function isDirectEntrypoint(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(path.resolve(entrypoint)).href === metaUrl;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exitCode = await runSoftwareMapCliEntry({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
