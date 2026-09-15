#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { nodeFloorMessage, supportedNodeRuntime } from "./node-floor.js";

// The floor check runs before program.js loads: an old Node fails with one
// line instead of a syntax or missing-builtin crash deeper in. Nothing is
// written to disk before this point.
process.exitCode = await main();

async function main(): Promise<number> {
  if (!supportedNodeRuntime(process.versions.node)) {
    process.stderr.write(nodeFloorMessage(process.versions.node));

    return 1;
  }

  const { runTracesCli } = await import("./program.js");

  return runTracesCli({
    argv: process.argv.slice(2),
    ownCliPath: fileURLToPath(import.meta.url),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
