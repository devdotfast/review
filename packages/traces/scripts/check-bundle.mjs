// Fails the build when the bundle reaches app-only code or leaves a runtime
// dependency external. The self-install copies dist/ without node_modules, so
// only node: builtins may stay external.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const distDir = join(packageRoot, "dist");

const EXPECTED_FILES = ["build-info.json", "cli.js", "program.js"];

const FORBIDDEN = [
  /isomorphic-git/,
  /["']react(?:-dom)?["']/,
  /review-state-store/,
  /review-home/,
  /node:sqlite/,
  /desktop-host/,
];

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

const problems = [];

const present = (await readdir(distDir)).sort();

if (present.join(",") !== EXPECTED_FILES.join(",")) {
  problems.push(
    `dist/ holds [${present.join(", ")}]; expected exactly [${EXPECTED_FILES.join(", ")}]`,
  );
}

const sizes = [];

for (const file of ["cli.js", "program.js"]) {
  const filePath = join(distDir, file);
  const source = await readFile(filePath, "utf8");
  sizes.push(
    `dist/${file} ${((await stat(filePath)).size / 1024).toFixed(0)} KiB`,
  );

  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) problems.push(`dist/${file} contains ${pattern}`);
  }

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];

    if (!specifier) continue;

    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;

    if (specifier.startsWith("node:")) continue;
    problems.push(`dist/${file} imports ${specifier}, which is not bundled`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}

process.stdout.write(`bundle ok: ${sizes.join(", ")}\n`);
