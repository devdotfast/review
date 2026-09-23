#!/usr/bin/env node

import { runLegacyReviewCli } from "./legacy-rename.js";

process.exitCode = await runLegacyReviewCli(
  process.argv.slice(2),
  process.stdin,
  process.stdout,
  process.stderr,
);
