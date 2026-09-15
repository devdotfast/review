#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const { runTracesCli } = await import("./program.js");

process.exitCode = await runTracesCli({
  argv: process.argv.slice(2),
  ownCliPath: fileURLToPath(import.meta.url),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
