import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(packageRoot, "dist", "cli.js");
const desktopHostPath = resolve(
  packageRoot,
  "dist",
  "server",
  "desktop-host.js",
);

export default defineConfig({
  entry: {
    authoring: "src/authoring.ts",
    cli: "src/cli.ts",
    "native-agent/native-hook-client": "src/native-agent/native-hook-client.ts",
    "native-agent/pi-observer-extension":
      "src/native-agent/pi-observer-extension.ts",
    runtime: "src/runtime.ts",
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
      /^@dev-fast\/local-vcs$/,
      /^@dev\.fast\/review-protocol$/,
      /^isomorphic-git$/,
    ],
    onlyBundle: false,
    neverBundle: ["typescript"],
  },
  async onSuccess() {
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
