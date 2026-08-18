import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_HARNESS_GLOB = "**/review/harness/**/*.test.js";

if (process.argv.length !== 2) {
  console.error("npm run test-review-harness does not accept arguments");
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["test/unit/node/index.js", "--runGlob", REVIEW_HARNESS_GLOB],
  {
    cwd: root,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
