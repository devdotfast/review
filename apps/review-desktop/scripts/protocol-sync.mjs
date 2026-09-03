#!/usr/bin/env node
// Regenerates the Code OSS protocol overlay from packages/review-protocol/src.
// Byte-compares before writing so an unchanged protocol keeps its mtime
// (freshness.sh gates incremental builds on it).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const monorepoRoot = path.resolve(appDirectory, "..", "..");
const generatorPath = path.join(
  monorepoRoot,
  "packages/review-protocol/scripts/generate-native-source.mjs",
);
const generatedProtocolPath = path.join(
  appDirectory,
  "code-oss/src/vs/review/common/reviewProtocol.ts",
);

function syncProtocol() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "review-desktop-protocol-"),
  );
  try {
    const temporaryPath = path.join(temporaryDirectory, "reviewProtocol.ts");
    execFileSync(process.execPath, [generatorPath, temporaryPath], {
      stdio: "inherit",
    });
    const generated = fs.readFileSync(temporaryPath, "utf8");
    const current = fs.existsSync(generatedProtocolPath)
      ? fs.readFileSync(generatedProtocolPath, "utf8")
      : null;
    if (current === generated) return false;
    fs.mkdirSync(path.dirname(generatedProtocolPath), { recursive: true });
    fs.writeFileSync(generatedProtocolPath, generated);
    return true;
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv.length !== 2) {
  throw new Error("usage: node scripts/protocol-sync.mjs");
}
syncProtocol();
