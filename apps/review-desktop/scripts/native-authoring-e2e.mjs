/** Alias kept for existing docs. The suite lives in scripts/e2e/run.mjs. */
import { spawnSync } from "node:child_process";
import path from "node:path";

const { status } = spawnSync(
  process.execPath,
  [
    path.join(import.meta.dirname, "e2e/run.mjs"),
    "--journey",
    "legacy-import,json-api-edit,tutorial",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

process.exit(status ?? 1);
