import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const packageRoot = dirname(fileURLToPath(import.meta.url));

const cliPath = resolve(packageRoot, "dist", "cli.js");

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const buildCommit = gitOutput(["rev-parse", "HEAD"]);

const buildChanges = gitOutput(["status", "--porcelain"]);

const desktopHostPath = resolve(
  packageRoot,
  "dist",
  "server",
  "desktop-host.js",
);

export default defineConfig({
  entry: {
    authoring: "src/authoring.ts",
    "document/worker": "src/document/worker.ts",
    cli: "src/cli.ts",
    "native-agent/native-hook-client": "src/native-agent/native-hook-client.ts",
    "native-agent/pi-bridge-extension":
      "src/native-agent/pi-bridge-extension.ts",
    runtime: "src/runtime.ts",
    traces: "src/traces-runtime.ts",
    "desktop-server": "src/server/desktop-server.ts",
    "server/desktop-host": "src/server/desktop-host.ts",
    "software-map-model": "src/software-map-model.ts",
    "tolerant-software-map-model": "src/tolerant-software-map-model.ts",
    "software-map-topology-diff": "src/software-map-topology-diff.ts",
  },
  platform: "node",
  target: "node24",
  format: "esm",
  outDir: "dist",
  fixedExtension: false,
  dts: true,
  deps: {
    alwaysBundle: [
      /^@dev\.fast\/json$/,
      /^@dev\.fast\/local-vcs$/,
      /^@dev\.fast\/review-protocol$/,
      /^@dev\.fast\/trace-shared$/,
      /^isomorphic-git$/,
    ],
    onlyBundle: false,
    neverBundle: ["typescript"],
  },
  async onSuccess() {
    const pkg = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );

    await writeFile(
      resolve(packageRoot, "dist", "build-info.json"),
      JSON.stringify({
        version: pkg.version,
        commit: buildCommit,
        dirty: buildChanges === null ? null : buildChanges.length > 0,
        builtAt: new Date().toISOString(),
      }) + "\n",
    );
    await Promise.all(
      [cliPath, desktopHostPath].map(async (executablePath) => {
        await normalizeExecutable(executablePath);
        await chmod(executablePath, 0o755);
      }),
    );
  },
});

async function normalizeExecutable(filePath: string): Promise<void> {
  const shebang = "#!/usr/bin/env node\n";
  const contents = await readFile(filePath, "utf8");
  const body = contents.replace(/^(?:#![^\n]*\n|\s*\n)+/, "");
  await writeFile(filePath, `${shebang}${body}`, "utf8");
}
