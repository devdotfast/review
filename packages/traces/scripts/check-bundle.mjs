// Fails the build when the bundle reaches app-only code or leaves a runtime
// dependency external. The self-install copies dist/ without node_modules, so
// only node: builtins may stay external.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const distDir = join(packageRoot, "dist");

// The two entries, plus the build stamp. Rolldown puts each dynamic import of
// the library in its own chunk beside them; the self-install copies the whole
// dist directory, so those chunks travel with the entries.
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
// bundle puts several statements on one line. A build erases every `import
// type` line, so one in the bundle is text inside a string, such as the pi
// extension the library writes.
const SPECIFIER_PATTERN =
  /\b(?:import|export)\b(?!\s+type\b)[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\b(?:__)?require\s*\(\s*["']([^"']+)["']\s*\)/g;

const BUILTIN_MODULES = new Set(builtinModules);

/**
 * `source` without its `//` line comments. A comment can name a package the
 * bundle never imports, such as the note a library keeps above a shim.
 * A `//` inside a string or a URL stays: only a comment that starts the line,
 * or follows whitespace, is cut.
 */
function withoutLineComments(source) {
  const lines = [];

  for (const line of source.split("\n")) {
    const comment = /(^|\s)\/\/.*$/.exec(line);
    lines.push(comment ? line.slice(0, comment.index) : line);
  }

  return lines.join("\n");
}

/** The specifiers in `source` that the self-install cannot resolve. */
export function findForeignSpecifiers(source) {
  const foreign = new Set();

  for (const match of withoutLineComments(source).matchAll(SPECIFIER_PATTERN)) {
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

  for (const file of EXPECTED_FILES) {
    if (!present.includes(file)) problems.push(`dist/ misses ${file}`);
  }

  const scripts = [];

  for (const file of present) {
    if (file.endsWith(".js")) scripts.push(file);
    else if (file !== "build-info.json") {
      problems.push(`dist/ holds ${file}, which is neither a chunk nor a stamp`);
    }
  }

  let bytes = 0;

  for (const file of scripts) {
    const filePath = join(distDir, file);
    const source = await readFile(filePath, "utf8");
    bytes += (await stat(filePath)).size;

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

  process.stdout.write(
    `bundle ok: ${scripts.length} files, ${(bytes / 1024).toFixed(0)} KiB\n`,
  );
}

const invokedPath = process.argv[1];

const scriptPath = fileURLToPath(import.meta.url);

// Both sides are resolved through every link, so a run through a symlinked
// path, such as a `.bin` entry, still counts as running this script.
const runsAsScript =
  invokedPath !== undefined &&
  (await realpath(invokedPath).catch(() => resolve(invokedPath))) ===
    (await realpath(scriptPath).catch(() => scriptPath));

if (runsAsScript) await checkBundle();
