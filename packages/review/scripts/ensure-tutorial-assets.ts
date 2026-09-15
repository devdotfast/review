import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { buildTutorialAssets } from "./build-tutorial-assets";

const packageRoot = path.resolve(import.meta.dirname, "..");

const output = path.join(
  packageRoot,
  "tutorial",
  ".bundle",
  "document",
  "review-document.json",
);

const inputRoots = [
  path.join(packageRoot, "src"),
  path.join(packageRoot, "tutorial"),
  path.join(packageRoot, "scripts", "build-tutorial-assets.ts"),
  import.meta.filename,
  path.resolve(packageRoot, "..", "..", "pnpm-lock.yaml"),
];

const outputModifiedAt = await modifiedAt(output);

const inputsModifiedAt = Math.max(
  ...(await Promise.all(inputRoots.map((input) => newestInput(input)))),
);

if (outputModifiedAt < inputsModifiedAt) {
  const built = await buildTutorialAssets();
  process.stdout.write(
    `Tutorial assets built: commit ${built.commit}, ${built.peekCount} code ranges.\n`,
  );
} else {
  process.stdout.write("Tutorial assets are current.\n");
}

async function newestInput(input: string): Promise<number> {
  const entry = await stat(input);

  if (!entry.isDirectory()) return entry.mtimeMs;

  const children = await readdir(input, { withFileTypes: true });

  const modified = await Promise.all(
    children
      .filter((child) => child.name !== ".bundle" && child.name !== "git-stub")
      .map((child) => newestInput(path.join(input, child.name))),
  );

  return Math.max(0, ...modified);
}

async function modifiedAt(file: string): Promise<number> {
  return stat(file)
    .then((entry) => entry.mtimeMs)
    .catch(() => 0);
}
