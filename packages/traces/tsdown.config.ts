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

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    program: "src/program.ts",
  },
  platform: "node",
  target: "node22",
  format: "esm",
  outDir: "dist",
  fixedExtension: false,
  dts: false,
  deps: {
    alwaysBundle: [
      /^@dev\.fast\//,
      "commander",
      "zod",
      "git-url-parse",
      "proper-lockfile",
    ],
    onlyBundle: false,
  },
  async onSuccess() {
    const manifest = await readPackageManifest();

    await writeFile(
      resolve(packageRoot, "dist", "build-info.json"),
      JSON.stringify({
        version: manifest.version,
        commit: buildCommit,
        dirty: buildChanges === null ? null : buildChanges.length > 0,
        builtAt: new Date().toISOString(),
      }) + "\n",
    );
    await normalizeExecutable(cliPath);
    await chmod(cliPath, 0o755);
  },
});

async function readPackageManifest(): Promise<{ version: string }> {
  const text = await readFile(resolve(packageRoot, "package.json"), "utf8");

  return JSON.parse(text);
}

async function normalizeExecutable(filePath: string): Promise<void> {
  const shebang = "#!/usr/bin/env node\n";
  const contents = await readFile(filePath, "utf8");
  const body = contents.replace(/^(?:#![^\n]*\n|\s*\n)+/, "");
  await writeFile(filePath, `${shebang}${body}`, "utf8");
}
