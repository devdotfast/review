import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { valid as validVersion } from "semver";

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
 * binaries, TypeScript, workspace libraries, and app source assets.
 */
export const RUNTIME_DIRECTORY_NAME = "review-runtime";
export const RUNTIME_SERVER_ENTRY = "dist/server/desktop-host.js";

export const RUNTIME_CLI_ENTRY = "dist/cli.js";

export const REQUIRED_RUNTIME_ENTRIES = [
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  RUNTIME_SERVER_ENTRY,
  RUNTIME_CLI_ENTRY,
  "app/src",
  "skills/dev-review/SKILL.md",
  "skills/dev-review/docs/README.md",
  "skills/dev-review-map/SKILL.md",
  "skills/trace-archaeology/SKILL.md",
  "tutorial/runtime-manifest.json",
  "node_modules",
  "node_modules/@dev.fast/local-vcs/dist/index.js",
  "dist/document/worker.js",
  "dist/authoring.d.ts",
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

export function requiredPackagedArtifacts(packagedRoot) {
  const runtimeRoot = runtimeRootForPackagedRoot(packagedRoot);
  const packagedAppRoot = path.dirname(runtimeRoot);
  const entries = [
    "out/vs/review/review.desktop.main.js",
    "out/vs/review/review.desktop.main.css",
    "out/vs/review/electron-utility/reviewDesktopHostMain.js",
    "out/vs/review/canvas/canvas-loader.js",
    ...REQUIRED_RUNTIME_ENTRIES.map((entry) =>
      path.join(RUNTIME_DIRECTORY_NAME, entry),
    ),
  ];
  if (!path.resolve(packagedRoot).endsWith(".app")) {
    entries.push("extensions/vscodevim.vim/package.json");
  }
  return entries.map((entry) => path.join(packagedAppRoot, entry));
}

export async function assertPackagedArtifacts(packagedRoot) {
  await assertNoRuntimeBundler(packagedRoot);
  for (const artifact of requiredPackagedArtifacts(packagedRoot)) {
    try {
      await access(artifact);
    } catch {
      throw new Error(`Review Desktop package is missing ${artifact}.`);
    }
  }
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

  await stageReviewDocs(runtimeRoot);
  await stampReviewSkills(runtimeRoot);
  await makeTreeOwnerWritable(path.join(runtimeRoot, "tutorial", "git-stub"));
  await assertRuntimeClosure(runtimeRoot);
  return runtimeRoot;
}

/** Stamp only deployed copies, before signing; source skills remain editable. */
export async function stampReviewSkills(runtimeRoot, version) {
  const releaseVersion =
    version ??
    JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8"))
      .version;
  if (!validVersion(releaseVersion)) {
    throw new Error(
      "A Review Desktop release version is required to stamp skills.",
    );
  }
  const skillsRoot = path.join(runtimeRoot, "skills");
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    const source = await readFile(skillPath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (
      !frontmatter ||
      !/^  review-version: "[^"\n]+"$/m.test(frontmatter[1])
    ) {
      throw new Error(`Missing generated skill metadata: ${skillPath}`);
    }
    const stamped = frontmatter[0].replace(
      /^  review-version: "[^"\n]+"$/m,
      `  review-version: ${JSON.stringify(releaseVersion)}`,
    );
    // pnpm deploy may hardlink files from its store. Never modify that inode.
    await rm(skillPath);
    await writeFile(skillPath, stamped + source.slice(frontmatter[0].length));
  }
}

export async function stageReviewDocs(
  runtimeRoot,
  sourceDocsRoot = path.join(monorepoRoot, "docs"),
) {
  const skillRoot = path.join(runtimeRoot, "skills", "dev-review");
  if (!(await isDirectory(skillRoot))) {
    throw new Error(
      `Cannot stage Review documentation without the dev-review skill: ${skillRoot}`,
    );
  }
  if (!(await isDirectory(sourceDocsRoot))) {
    throw new Error(
      `Review documentation source is missing: ${sourceDocsRoot}`,
    );
  }

  const destination = path.join(skillRoot, "docs");
  await rm(destination, { recursive: true, force: true });
  await cp(sourceDocsRoot, destination, { recursive: true });
  await assertMatchingFileTrees(sourceDocsRoot, destination);
  return destination;
}

async function assertMatchingFileTrees(sourceRoot, destinationRoot) {
  const [sourceFiles, destinationFiles] = await Promise.all([
    listRelativeFiles(sourceRoot),
    listRelativeFiles(destinationRoot),
  ]);
  if (sourceFiles.join("\n") !== destinationFiles.join("\n")) {
    throw new Error(
      "The staged Review documentation file list does not match.",
    );
  }

  for (const relative of sourceFiles) {
    const [source, destination] = await Promise.all([
      readFile(path.join(sourceRoot, relative)),
      readFile(path.join(destinationRoot, relative)),
    ]);
    if (!source.equals(destination)) {
      throw new Error(
        `The staged Review documentation differs at ${relative}.`,
      );
    }
  }
}

async function listRelativeFiles(root) {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute));
      } else {
        throw new Error(
          `Review documentation contains an unsupported entry: ${absolute}`,
        );
      }
    }
  };
  await walk(root);
  return files;
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
  for (const entry of REQUIRED_RUNTIME_ENTRIES) {
    const target = path.join(runtimeRoot, entry);
    try {
      await access(target);
    } catch {
      throw new Error(`The staged Review runtime is missing ${entry}.`);
    }
  }
  const tutorialRoot = path.join(runtimeRoot, "tutorial");
  const tutorialManifest = await readTutorialRuntimeManifest(tutorialRoot);
  for (const entry of tutorialManifest.requiredPaths) {
    try {
      await access(path.join(tutorialRoot, entry));
    } catch {
      throw new Error(
        `The staged Review runtime is missing tutorial/${entry}.`,
      );
    }
  }
  await assertRuntimeContents(runtimeRoot);
}

export async function readTutorialRuntimeManifest(tutorialRoot) {
  const value = JSON.parse(
    await readFile(path.join(tutorialRoot, "runtime-manifest.json"), "utf8"),
  );
  const validEntries = (entries) =>
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every(isSafeManifestPath);
  if (
    value?.version !== 1 ||
    !validEntries(value.reviewFiles) ||
    !validEntries(value.requiredPaths) ||
    value.reviewFiles.some((entry) => !value.requiredPaths.includes(entry))
  ) {
    throw new Error("Tutorial runtime manifest is invalid.");
  }
  return {
    version: 1,
    reviewFiles: [...new Set(value.reviewFiles)],
    requiredPaths: [...new Set(value.requiredPaths)],
  };
}

/** A manifest entry that names a file inside the tutorial tree. */
function isSafeManifestPath(entry) {
  // Only a JSON string equals its own String() rendering by identity.
  return (
    String(entry) === entry &&
    entry.length > 0 &&
    !path.isAbsolute(entry) &&
    !entry.split(/[\\/]/u).includes("..")
  );
}

/** Final package verification includes files outside the staged runtime, such
 * as extension dependencies and ASAR archives, after all package mutations. */
export async function assertNoRuntimeBundler(runtimeRoot) {
  await inspectRuntimeTree(runtimeRoot, false);
}

/** Validate the staged dependency closure in one traversal. */
export async function assertRuntimeContents(runtimeRoot) {
  await inspectRuntimeTree(runtimeRoot, true);
}

async function inspectRuntimeTree(root, checkCheckoutReferences) {
  const runtimeRoot = await realpath(root);
  const offenders = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === "esbuild" || entry.name === "esbuild.exe") {
        throw new Error(
          `The Review runtime must not ship esbuild: ${path.relative(runtimeRoot, absolute)}`,
        );
      }
      if (entry.isSymbolicLink()) {
        if (checkCheckoutReferences) {
          const real = await realpathOrNull(absolute);
          if (!real) {
            offenders.push(
              `${path.relative(runtimeRoot, absolute)} (broken link)`,
            );
          } else if (
            real !== runtimeRoot &&
            !real.startsWith(runtimeRoot + path.sep)
          ) {
            offenders.push(
              `${path.relative(runtimeRoot, absolute)} -> ${real} (escapes runtime)`,
            );
          }
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".asar")) {
        await assertNoArchivedBundler(absolute);
        continue;
      }
      const isManifest = entry.name === "package.json";
      // Declarations and source maps can embed checkout paths just as emitted
      // JavaScript can. Read manifests once for both closure checks.
      const checkContents =
        checkCheckoutReferences &&
        (isManifest ||
          /\.[cm]?js\.map$/.test(entry.name) ||
          (/\.(?:[cm]?js|d\.[cm]?ts)$/.test(entry.name) &&
            absolute.includes(`${path.sep}dist${path.sep}`)));
      if (!isManifest && !checkContents) continue;
      const contents = await readFile(absolute, "utf8");
      if (isManifest) {
        const manifest = JSON.parse(contents);
        if (
          manifest.name === "esbuild" ||
          manifest.name?.startsWith("@esbuild/")
        )
          throw new Error(
            `The Review runtime must not ship ${manifest.name}: ${path.relative(runtimeRoot, absolute)}`,
          );
      }
      if (checkContents && contents.includes(monorepoRoot)) {
        offenders.push(
          `${path.relative(runtimeRoot, absolute)} (build checkout path)`,
        );
      }
    }
  };
  await visit(runtimeRoot);
  if (offenders.length > 0) {
    throw new Error(
      `The staged Review runtime is not relocatable:\n  ${offenders.join("\n  ")}`,
    );
  }
}

// ASAR headers are two Chromium pickles: an 8-byte size pickle followed by
// a string pickle containing the JSON tree. Inspect the directory without
// extracting the app or requiring an archive tool in the installed runtime.
async function assertNoArchivedBundler(archive) {
  const file = await open(archive, "r");
  try {
    const prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16)
      throw new Error(`Invalid ASAR header: ${archive}`);
    const headerBytes = prefix.readUInt32LE(4);
    const jsonBytes = prefix.readUInt32LE(12);
    if (jsonBytes > headerBytes - 8 || headerBytes > 64 * 1024 * 1024)
      throw new Error(`Invalid ASAR header size: ${archive}`);
    const contents = Buffer.alloc(jsonBytes);
    if ((await file.read(contents, 0, jsonBytes, 16)).bytesRead !== jsonBytes)
      throw new Error(`Truncated ASAR header: ${archive}`);
    const visit = (node, parent = "") => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const relative = `${parent}/${name}`;
        if (name === "esbuild" || name === "esbuild.exe" || name === "@esbuild")
          throw new Error(
            `The Review runtime must not ship esbuild: ${archive}:${relative}`,
          );
        visit(child, relative);
      }
    };
    visit(JSON.parse(contents.toString("utf8")));
  } finally {
    await file.close();
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
  const verifyOnly = args[0] === "--verify";
  const packagedRootIndex = verifyOnly ? 1 : 0;
  if (
    args.length !== packagedRootIndex + 2 ||
    args[packagedRootIndex] !== "--packaged-root"
  ) {
    throw new Error(
      "usage: stage-review-runtime.mjs [--verify] --packaged-root <packaged-app-root>",
    );
  }
  const packagedRoot = args[packagedRootIndex + 1];
  if (verifyOnly) {
    await assertPackagedArtifacts(packagedRoot);
    process.stdout.write(`Verified the Review package at ${packagedRoot}\n`);
  } else {
    const runtimeRoot = await stageReviewRuntime(packagedRoot);
    process.stdout.write(`Staged the Review runtime at ${runtimeRoot}\n`);
  }
}
