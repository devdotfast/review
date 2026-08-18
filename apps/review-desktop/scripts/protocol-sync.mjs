import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const monorepoRoot = path.resolve(appDirectory, "../..");
const protocolGeneratorPath = path.join(
  monorepoRoot,
  "packages/review-protocol/scripts/generate-native-source.mjs",
);
const generatedProtocolPath = path.join(
  appDirectory,
  "code-oss/src/vs/review/common/reviewProtocol.ts",
);
const check = process.argv[2] === "--check";

if (process.argv.length > (check ? 3 : 2)) {
  throw new Error("usage: node scripts/protocol-sync.mjs [--check]");
}

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "review-desktop-protocol-"),
);
const temporaryProtocolPath = path.join(
  temporaryDirectory,
  "reviewProtocol.ts",
);

try {
  execFileSync(process.execPath, [
    protocolGeneratorPath,
    temporaryProtocolPath,
  ]);
  const generated = fs.readFileSync(temporaryProtocolPath, "utf8");

  if (check) {
    const current = fs.readFileSync(generatedProtocolPath, "utf8");
    if (current !== generated) {
      console.error(
        "Review Desktop protocol is stale; run pnpm --filter @dev-fast/review-desktop protocol:sync",
      );
      process.exitCode = 1;
    }
  } else {
    const current = fs.existsSync(generatedProtocolPath)
      ? fs.readFileSync(generatedProtocolPath, "utf8")
      : null;
    if (current !== generated) {
      fs.mkdirSync(path.dirname(generatedProtocolPath), { recursive: true });
      fs.writeFileSync(generatedProtocolPath, generated);
    }
  }
} finally {
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
}
