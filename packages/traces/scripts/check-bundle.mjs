// Fails the build when the bundle reaches app-only code or leaves a runtime
// dependency external. The self-install copies dist/ without node_modules, so
// only node: builtins may stay external.
import { readFile, readdir, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
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

// Rolldown writes four specifier forms: `import`/`export ... from`, a dynamic
// `import(...)`, a bare `import "x"`, and `__require("x")` for the CommonJS
// packages it bundles. The scan reads the whole file at once, because the
// bundle puts several statements on one line.
const SPECIFIER_PATTERN =
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\b(?:__)?require\s*\(\s*["']([^"']+)["']\s*\)/g;

const BUILTIN_MODULES = new Set(builtinModules);

/** The specifiers in `source` that the self-install cannot resolve. */
export function findForeignSpecifiers(source) {
  const foreign = new Set();

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];

    if (!specifier) continue;

    if (specifier.startsWith(".")) continue;

    if (specifier.startsWith("node:")) continue;

    if (BUILTIN_MODULES.has(specifier)) continue;
    foreign.add(specifier);
  }

  return [...foreign];
}

async function checkBundle() {
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
      if (pattern.test(source)) {
        problems.push(`dist/${file} contains ${pattern}`);
      }
    }

    for (const specifier of findForeignSpecifiers(source)) {
      problems.push(`dist/${file} imports ${specifier}, which is not bundled`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exit(1);
  }

  process.stdout.write(`bundle ok: ${sizes.join(", ")}\n`);
}

const invokedPath = process.argv[1];

const runsAsScript =
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url);

if (runsAsScript) await checkBundle();
