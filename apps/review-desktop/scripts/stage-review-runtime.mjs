import { execFile } from "node:child_process";
import {
  access,
  chmod,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const monorepoRoot = path.resolve(appDirectory, "../..");

/**
 * The installed application must not reach back into the build checkout, so the
 * Review server ships as a self-contained production dependency closure rather
 * than as a single bundled file: the runtime intentionally depends on native
 * binaries, TypeScript, esbuild, workspace libraries, and app source assets.
 */
export const RUNTIME_DIRECTORY_NAME = "review-runtime";
export const RUNTIME_SERVER_ENTRY = "dist/server/desktop-host.js";

export const RUNTIME_CLI_ENTRY = "dist/cli.js";

/**
 * esbuild ships one native binary per platform; the staged closure carries the
 * one pnpm resolved for the packaging host.
 */
function esbuildPlatformEntry() {
  const platform = `${process.platform}-${process.arch}`;
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
  ]);
  if (!supported.has(platform)) {
    throw new Error(`Review runtime staging does not support ${platform}.`);
  }
  return `node_modules/@esbuild/${platform}/bin/esbuild`;
}

const REQUIRED_ENTRIES = [
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  RUNTIME_SERVER_ENTRY,
  RUNTIME_CLI_ENTRY,
  "app/src",
  "skills/dev-review/SKILL.md",
  "skills/dev-review-map/SKILL.md",
  "tutorial/review.mdx",
  "tutorial/data.ts",
  "tutorial/software-map.ts",
  "tutorial/sample-service/package.json",
  "tutorial/git-stub/HEAD",
  "tutorial/.bundle/document/review-document.js",
  "tutorial/.bundle/document/manifest.json",
  "tutorial/.bundle/software-map/head-map.js",
  "tutorial/.bundle/software-map/base-map.js",
  "tutorial/.bundle/software-map/manifest.json",
  "node_modules",
  "node_modules/@dev.fast/local-vcs/dist/index.js",
  esbuildPlatformEntry(),
];

export function runtimeRootForPackagedRoot(packagedRoot) {
  const resolved = path.resolve(packagedRoot);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The packaged Review root cannot be a filesystem root.");
  }
  const packagedAppRoot = resolved.endsWith(".app")
    ? path.join(resolved, "Contents/Resources/app")
    : path.join(resolved, "resources/app");
  return path.join(packagedAppRoot, RUNTIME_DIRECTORY_NAME);
}

export async function stageReviewRuntime(packagedRoot) {
  const runtimeRoot = runtimeRootForPackagedRoot(packagedRoot);
  const packagedAppRoot = path.dirname(runtimeRoot);
  if (!(await isDirectory(packagedAppRoot))) {
    throw new Error(
      `Refusing to stage the Review runtime outside a packaged app: ${packagedAppRoot}`,
    );
  }

  await rm(runtimeRoot, { recursive: true, force: true });
  await execFileAsync(
    "pnpm",
    [
      "--config.allow-unused-patches=true",
      // This workspace pins `nodeLinker: hoisted`, under which a plain deploy
      // links workspace dependencies back to the checkout and never resolves
      // their own dependency graphs. Injecting copies them in with their deps.
      "--config.inject-workspace-packages=true",
      "--filter",
      "@dev.fast/review",
      "--prod",
      "deploy",
      "--legacy",
      // Keeps the root prepare/Husky lifecycle out of packaging.
      "--ignore-scripts",
      runtimeRoot,
    ],
    { cwd: monorepoRoot, maxBuffer: 64 * 1024 * 1024 },
  );

  await makeTreeOwnerWritable(path.join(runtimeRoot, "tutorial", "git-stub"));
  await assertRuntimeClosure(runtimeRoot);
  return runtimeRoot;
}

async function makeTreeOwnerWritable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeOwnerWritable(absolute);
      continue;
    }
    if (!entry.isFile()) continue;

    const current = await stat(absolute);
    if ((current.mode & 0o200) === 0) {
      await chmod(absolute, current.mode | 0o200);
    }
  }
}

export async function assertRuntimeClosure(runtimeRoot) {
  for (const entry of REQUIRED_ENTRIES) {
    const target = path.join(runtimeRoot, entry);
    try {
      await access(target);
    } catch {
      throw new Error(`The staged Review runtime is missing ${entry}.`);
    }
  }
  await assertNoCheckoutReferences(runtimeRoot);
}

/**
 * A relocatable closure must not name the machine that produced it. Symlinks
 * escaping the runtime root break once the app is copied out of the build tree,
 * and manifests holding absolute checkout paths break just as silently.
 */
export async function assertNoCheckoutReferences(runtimeRoot) {
  const offenders = [];
  const manifests = [];

  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await stat(absolute).catch(() => null);
        if (!target) {
          offenders.push(
            `${path.relative(runtimeRoot, absolute)} (broken link)`,
          );
          continue;
        }
        const real = await realpathOrNull(absolute);
        if (real && !real.startsWith(runtimeRoot + path.sep)) {
          offenders.push(
            `${path.relative(runtimeRoot, absolute)} -> ${real} (escapes runtime)`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      // Manifests are the obvious place a build path leaks, but source maps
      // and emitted JavaScript embed absolute paths just as easily, and a
      // dynamic import built from one fails only once the app is installed.
      if (
        entry.name === "package.json" ||
        entry.name.endsWith(".js.map") ||
        entry.name.endsWith(".cjs.map") ||
        entry.name.endsWith(".mjs.map") ||
        (entry.name.endsWith(".js") &&
          absolute.includes(`${path.sep}dist${path.sep}`))
      ) {
        manifests.push(absolute);
      }
    }
  };
  await walk(runtimeRoot);

  for (const manifest of manifests) {
    const contents = await readFile(manifest, "utf8");
    if (contents.includes(monorepoRoot)) {
      offenders.push(
        `${path.relative(runtimeRoot, manifest)} (build checkout path)`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `The staged Review runtime is not relocatable:\n  ${offenders.join("\n  ")}`,
    );
  }
}

async function realpathOrNull(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--packaged-root") {
    throw new Error(
      "usage: stage-review-runtime.mjs --packaged-root <packaged-app-root>",
    );
  }
  const runtimeRoot = await stageReviewRuntime(args[1]);
  process.stdout.write(`Staged the Review runtime at ${runtimeRoot}\n`);
}
