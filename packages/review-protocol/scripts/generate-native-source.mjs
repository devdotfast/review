#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = process.argv[2];
if (!outputPath || process.argv.length !== 3) {
  throw new Error("Usage: generate-native-source.mjs <output-path>");
}

const contracts = readFileSync(
  path.join(packageRoot, "src/contracts.ts"),
  "utf8",
).replace(
  'import { z } from "zod";',
  'import { z } from "zod/v4";\n\nz.config({ jitless: true });',
);
const index = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  .replace(/^import \{ z \} from "zod";\n\n/, "")
  .replace(/import \{[\s\S]*?\} from "\.\/contracts\.js";\n\n/, "")
  .replace('export * from "./bug-report.js";\n', "")
  .replace('export * from "./contracts.js";\n\n', "");

writeFileSync(
  outputPath,
  [
    "// GENERATED from @dev.fast/review-protocol. Do not edit.",
    contracts.trimEnd(),
    "",
    index.trimStart(),
  ].join("\n"),
);
