#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(packageRoot, "../..");
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || process.argv.length !== 4) {
  throw new Error(
    "Usage: bundle-native-runtime.mjs <input-path> <output-path>",
  );
}

const result = await build({
  alias: {
    "zod/v4": path.join(workspaceRoot, "node_modules/zod/v4/index.js"),
  },
  bundle: true,
  entryPoints: [path.resolve(inputPath)],
  format: "esm",
  logLevel: "warning",
  platform: "browser",
  target: "es2022",
  write: false,
});
if (result.outputFiles.length !== 1) {
  throw new Error("Expected one bundled native runtime output");
}
writeFileSync(path.resolve(outputPath), result.outputFiles[0].contents);
