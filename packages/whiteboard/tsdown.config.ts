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
    "sharing/index": "src/sharing/index.ts",
    cli: "src/cli.ts",
    "whiteboard-cli": "src/whiteboard-cli.ts",
    runtime: "src/runtime.ts",
    "server/desktop-host": "src/server/desktop-host.ts",
    "software-map-model": "src/software-map-model.ts",
  },
  platform: "node",
  target: "node24",
  format: "esm",
  outDir: "dist",
  fixedExtension: false,
  dts: true,
  // The external declaration edge has no global augmentation or runtime effect.
  // Used bindings stay bundled; the published declarations need no core package.
  treeshake: {
    moduleSideEffects: [
      { test: /^@dev\.fast\/trace-core$/, external: true, sideEffects: false },
    ],
  },
  deps: {
    alwaysBundle: [
      "@dev.fast/trace-core",
      /^@dev\.fast\/diffr$/,
      /^@dev\.fast\/json$/,
      /^@dev\.fast\/local-vcs$/,
      /^@dev\.fast\/review-protocol$/,
      /^@dev\.fast\/review-share-protocol$/,
      /^@dev\.fast\/trace-protocol$/,
      /^isomorphic-git$/,
    ],
    // Re-inlining core's public declaration graph exhausts the default Node heap.
    // Its only remaining declaration edge is the side-effect import handled above.
    dts: { neverBundle: ["@dev.fast/trace-core"] },
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
      [
        cliPath,
        resolve(packageRoot, "dist", "whiteboard-cli.js"),
        desktopHostPath,
      ].map(async (executablePath) => {
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
