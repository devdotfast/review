#!/usr/bin/env node
// Emits the single-file Review protocol overlay that the Code OSS fork
// imports as vs/review/common/reviewProtocol.ts. The overlay is every
// top-level statement of the protocol modules except import and re-export
// statements, behind one zod/v4 import configured for the Trusted Types CSP
// before any schema is built. bug-report.ts is deliberately not part of the
// overlay.
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
const isValidArgs =
  outputPath &&
  !outputPath.startsWith("--") &&
  sourceRoot &&
  (sourceRootFlag === -1
    ? args.length === 1
    : args.length === 3 && sourceRootFlag === 1);
if (!isValidArgs) {
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
  "",
].join("\n");

/**
 * Drops top-level `import …;` and `export … from "…";` statements,
 * including ones wrapped across multiple lines. A statement starts on a
 * line beginning with `import `, `export *`, `export {`, or `export type
 * {`; every such statement is buffered up to the line that ends with `;`
 * and then dropped only if it starts with `import ` or contains a `from
 * "…"` clause. That keeps local re-export lists (`export { a, b };`) and
 * all `export const/function/type/interface …` declarations, which never
 * match the opener pattern and so are kept immediately, line by line.
 */
function stripModuleStatements(source) {
  const kept = [];
  let buffer = null;
  for (const line of source.split("\n")) {
    if (
      buffer === null &&
      !/^(import\s|export\s+(\*|type\s+\{|\{))/.test(line)
    ) {
      kept.push(line);
      continue;
    }
    buffer = buffer === null ? [line] : [...buffer, line];
    if (!line.trimEnd().endsWith(";")) continue;
    const statement = buffer.join("\n");
    if (!/^import\s/.test(statement) && !/\bfrom\s*["']/.test(statement)) {
      kept.push(...buffer);
    }
    buffer = null;
  }
  return kept.join("\n").replace(/^\n+/, "").trimEnd();
}

// Dependencies first: every module may only name things declared above it,
// because concatenation is all that replaces the dropped relative imports.
const MODULE_FILES = [
  "runtime-value.ts",
  "json.ts",
  "contracts.ts",
  "index.ts",
];

const modules = MODULE_FILES.map((file) =>
  stripModuleStatements(readFileSync(path.join(sourceRoot, file), "utf8")),
);

writeFileSync(outputPath, `${HEADER}${modules.join("\n\n")}\n`);
