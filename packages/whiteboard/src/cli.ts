#!/usr/bin/env node

import { runLegacyWhiteboardCli } from "./legacy-rename.js";

process.exitCode = await runLegacyWhiteboardCli(
  process.argv.slice(2),
  process.stdin,
  process.stdout,
  process.stderr,
);
