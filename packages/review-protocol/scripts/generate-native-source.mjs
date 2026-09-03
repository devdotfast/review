#!/usr/bin/env node
// Emits the single-file Review protocol overlay that the Code OSS fork
// imports as vs/review/common/reviewProtocol.ts. The overlay is every
// top-level statement of contracts.ts and index.ts except import and
// re-export statements, behind one zod/v4 import configured for the
// Trusted Types CSP before any schema is built. bug-report.ts is
// deliberately not part of the overlay.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const outputPath = args[0];
const sourceRootFlag = args.indexOf("--source-root");
const sourceRoot =
  sourceRootFlag === -1
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
    : args[sourceRootFlag + 1];
if (!outputPath || outputPath.startsWith("--") || !sourceRoot) {
  throw new Error(
    "Usage: generate-native-source.mjs <output-path> [--source-root <dir>]",
  );
}

const HEADER = [
  "// GENERATED from @dev.fast/review-protocol. Do not edit.",
  'import { z } from "zod/v4";',
  "",
  "z.config({ jitless: true });",
  "",
].join("\n");

/**
 * Drops top-level `import …;` and `export … from "…";` statements. A
 * statement starts on a line that begins with `import ` or matches
 * `export (\*|\{)` and ends at the first line that ends with `;`. Multi-line
 * named-import blocks are therefore removed whole regardless of formatting.
 */
function stripModuleStatements(source) {
  const kept = [];
  let skipping = false;
  for (const line of source.split("\n")) {
    if (!skipping) {
      const startsImport = /^import\s/.test(line);
      const startsReexport =
        /^export\s+(\*|\{)/.test(line) &&
        /\sfrom\s/.test(line.includes(";") ? line : `${line} from`);
      if (startsImport || startsReexport) {
        skipping = !line.trimEnd().endsWith(";");
        continue;
      }
      kept.push(line);
      continue;
    }
    if (line.trimEnd().endsWith(";")) skipping = false;
  }
  return kept.join("\n").replace(/^\n+/, "").trimEnd();
}

const contracts = stripModuleStatements(
  readFileSync(path.join(sourceRoot, "contracts.ts"), "utf8"),
);
const index = stripModuleStatements(
  readFileSync(path.join(sourceRoot, "index.ts"), "utf8"),
);

writeFileSync(outputPath, `${HEADER}${contracts}\n\n${index}\n`);
