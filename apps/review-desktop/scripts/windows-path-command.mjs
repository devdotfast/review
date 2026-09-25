import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Replaces the Code OSS editor launchers in <packaged root>\bin with the
// `whiteboard` CLI, which the installer's "Add to PATH" task puts on PATH.
const packagedRoot = path.resolve(process.argv[2]);

const product = JSON.parse(
  readFileSync(path.join(packagedRoot, "resources/app/product.json"), "utf8"),
);

const bin = path.join(packagedRoot, "bin");

const exe = `${product.nameShort}.exe`;

const cli = "resources/app/review-runtime/dist/cli.js";

for (const name of [product.applicationName, `${product.applicationName}.cmd`])
  rmSync(path.join(bin, name), { force: true });

writeFileSync(
  path.join(bin, "whiteboard.cmd"),
  [
    "@echo off",
    "rem Managed by Whiteboard Desktop. Do not edit.",
    "setlocal DisableDelayedExpansion",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%~dp0..\\${exe}" "%~dp0..\\${cli.replaceAll("/", "\\")}" %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"),
);

// Git Bash finds the extensionless launcher before the .cmd file.
writeFileSync(
  path.join(bin, "whiteboard"),
  `#!/usr/bin/env sh
# Managed by Whiteboard Desktop. Do not edit.
ROOT=$(dirname "$(dirname "$(realpath "$0")")")
CLI="$ROOT/${cli}"
if command -v cygpath >/dev/null 2>&1; then CLI=$(cygpath -m "$CLI"); fi
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/${exe}" "$CLI" "$@"
`,
  { mode: 0o755 },
);
