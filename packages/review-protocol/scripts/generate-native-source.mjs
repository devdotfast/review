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

// json.ts and runtime-value.ts are inlined ahead of contracts.ts, so every
// relative import between the protocol modules is dropped.
const stripRelativeImports = (source) =>
  source.replace(/^import (?:type )?\{[^}]*\} from "\.\/[^"]+";\n\n?/gm, "");
const runtimeValue = readFileSync(
  path.join(packageRoot, "src/runtime-value.ts"),
  "utf8",
);
const json = stripRelativeImports(
  readFileSync(path.join(packageRoot, "src/json.ts"), "utf8"),
);
const contracts = stripRelativeImports(
  readFileSync(path.join(packageRoot, "src/contracts.ts"), "utf8"),
).replace(
  'import { z } from "zod";',
  'import { z } from "zod/v4";\n\nz.config({ jitless: true });',
);
const index = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  .replace(/^import \{ z \} from "zod";\n\n/, "")
  .replace(/import \{[\s\S]*?\} from "\.\/contracts\.js";\n/, "")
  .replace('import type { JsonValue } from "./json.js";\n\n', "")
  .replace('export * from "./bug-report.js";\n', "")
  .replace('export * from "./json.js";\n', "")
  .replace('export * from "./runtime-value.js";\n', "")
  .replace('export * from "./contracts.js";\n\n', "");

writeFileSync(
  outputPath,
  [
    "// GENERATED from @dev.fast/review-protocol. Do not edit.",
    runtimeValue.trimEnd(),
    "",
    json.trimEnd(),
    "",
    contracts.trimEnd(),
    "",
    index.trimStart(),
  ].join("\n"),
);
