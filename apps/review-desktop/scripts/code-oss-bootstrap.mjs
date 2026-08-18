import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { dirs } from "../code-oss/build/npm/dirs.ts";

const installInputNames = ["package.json", "package-lock.json", ".npmrc"];

export function needsDependencyInstall({
  dependencyDirectoriesExist,
  installedLockfileDigest,
  lockfileDigest,
}) {
  return (
    !dependencyDirectoriesExist ||
    !installedLockfileDigest ||
    installedLockfileDigest !== lockfileDigest
  );
}

export function dependencyDirectoriesExist(checkoutPath, installDirs = dirs) {
  return installDirs.every((directory) =>
    existsSync(join(checkoutPath, directory, "node_modules")),
  );
}

export function installInputPaths(checkoutPath, installDirs = dirs) {
  return [
    ...installDirs.flatMap((directory) =>
      installInputNames
        .map((name) => join(checkoutPath, directory, name))
        .filter(existsSync),
    ),
    join(checkoutPath, ".nvmrc"),
  ].filter(existsSync);
}

export async function lockfileDigest(checkoutPath, installDirs = dirs) {
  const digest = createHash("sha256");
  digest.update(process.versions.node);
  digest.update("\0");

  for (const inputPath of installInputPaths(checkoutPath, installDirs).sort()) {
    digest.update(relative(checkoutPath, inputPath));
    digest.update("\0");
    digest.update(await readFile(inputPath));
    digest.update("\0");
  }

  return digest.digest("hex");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "digest" && args.length === 1) {
    const [checkoutPath] = args;
    console.log(await lockfileDigest(checkoutPath));
    return;
  }
  if (command === "needs-install" && args.length === 2) {
    const [checkoutPath, stampPath] = args;
    const installedLockfileDigest = existsSync(stampPath)
      ? (await readFile(stampPath, "utf8")).trim()
      : undefined;
    console.log(
      needsDependencyInstall({
        dependencyDirectoriesExist: dependencyDirectoriesExist(checkoutPath),
        installedLockfileDigest,
        lockfileDigest: await lockfileDigest(checkoutPath),
      }),
    );
    return;
  }

  throw new Error(
    "usage: code-oss-bootstrap.mjs digest <checkout> | needs-install <checkout> <stamp>",
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
