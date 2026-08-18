import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withFileLock } from "../../../scripts/file-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), "..");
const packageRootHash = createHash("sha256")
  .update(packageRoot)
  .digest("hex")
  .slice(0, 16);
const buildFingerprintPath = join(
  tmpdir(),
  `dev-fast-local-vcs-build-${packageRootHash}.fingerprint`,
);
const buildInputPaths = [
  join(packageRoot, "../../pnpm-lock.yaml"),
  join(packageRoot, "package.json"),
  join(packageRoot, "scripts/build.mjs"),
  join(packageRoot, "src"),
  join(packageRoot, "tsconfig.json"),
  join(packageRoot, "tsdown.config.ts"),
];
export const buildLockPath = join(
  tmpdir(),
  `dev-fast-local-vcs-build-${packageRootHash}.lock`,
);

export async function withLocalVcsBuildLock(callback, overrides = {}) {
  const lockPath = overrides.lockPath ?? buildLockPath;
  return await withFileLock(
    {
      createTimeoutError: () =>
        new Error(`Timed out waiting for local-vcs build lock ${lockPath}.`),
      lockPath,
      pollMs: overrides.pollMs ?? 100,
      staleMs: overrides.staleMs ?? 30_000,
      timeoutMs: overrides.timeoutMs ?? 120_000,
      updateMs: overrides.updateMs ?? 10_000,
    },
    callback,
  );
}

async function runBuild() {
  await withLocalVcsBuildLock(async () => {
    const fingerprint = await calculateBuildFingerprint();
    if (await hasCurrentBuild(fingerprint)) {
      return;
    }
    await new Promise((resolveBuild, rejectBuild) => {
      const child = spawn("tsdown", [], {
        cwd: packageRoot,
        env: process.env,
        stdio: "inherit",
      });
      child.once("error", rejectBuild);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolveBuild();
          return;
        }
        rejectBuild(
          new Error(
            `tsdown failed (${signal ?? code ?? "unknown exit status"}).`,
          ),
        );
      });
    });
    await writeFile(buildFingerprintPath, `${fingerprint}\n`);
  });
}

async function hasCurrentBuild(fingerprint) {
  const [builtJavaScript, builtTypes, recordedFingerprint] = await Promise.all([
    stat(join(packageRoot, "dist/index.js")).catch(() => undefined),
    stat(join(packageRoot, "dist/index.d.ts")).catch(() => undefined),
    readFile(buildFingerprintPath, "utf8").catch(() => undefined),
  ]);
  return (
    builtJavaScript?.isFile() === true &&
    builtTypes?.isFile() === true &&
    recordedFingerprint?.trim() === fingerprint
  );
}

async function calculateBuildFingerprint() {
  const files = (
    await Promise.all(buildInputPaths.map((inputPath) => listFiles(inputPath)))
  )
    .flat()
    .sort();
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(relative(packageRoot, filePath));
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(inputPath) {
  const info = await stat(inputPath);
  if (!info.isDirectory()) {
    return [inputPath];
  }
  const entries = await readdir(inputPath, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => listFiles(join(inputPath, entry.name))),
    )
  ).flat();
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  await runBuild();
}
