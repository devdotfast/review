#!/usr/bin/env node
import path from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { runReviewCli } from "./cli-routing";

export interface SoftwareMapCliEntryInput {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}

export async function runSoftwareMapCliEntry(
  input: SoftwareMapCliEntryInput,
): Promise<number> {
  return runReviewCli({
    argv: ["map", ...input.args],
    cwd: input.cwd,
    env: input.env,
    stdout: input.stdout,
    stderr: input.stderr,
    stdin: process.stdin,
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
