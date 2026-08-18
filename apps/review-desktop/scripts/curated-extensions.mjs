#!/usr/bin/env node
// Materializes Review's curated built-in extensions.
//
// VSIXes are fetched from Open VSX, checked against the pinned digests in
// curated-extensions.manifest.mjs, and unpacked into code-oss/extensions/<id>/
// where the builtin extension scanner finds them. Everything it writes is
// gitignored, so a working copy stays clean.
//
//   node scripts/curated-extensions.mjs                  # materialize bundled groups
//   node scripts/curated-extensions.mjs --only=rust,vim  # just those groups
//   node scripts/curated-extensions.mjs --check          # verify, never download
//   node scripts/curated-extensions.mjs --print-hashes   # re-pin after a bump
//   node scripts/curated-extensions.mjs --clean          # remove materialized dirs
//   node scripts/curated-extensions.mjs --copy-to <dir>  # stage into a package

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  curatedExtensions,
  curatedGroups,
  openVsxUrl,
  parseGroupSelection,
  supportedTargets,
  targetKeyFor,
} from "./curated-extensions.manifest.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKOUT = path.join(APP_DIR, "code-oss");
const EXTENSIONS_DIR = path.join(CHECKOUT, "extensions");
const CACHE_DIR = path.join(CHECKOUT, ".build", "curated-extensions", "cache");
const STAMP_FILE = ".curated.json";

/** Maps process.platform/arch onto the manifest's target names. */
export function detectTarget() {
  const platform = { darwin: "darwin", linux: "linux", win32: "win32" }[
    os.platform()
  ];
  const arch = { arm64: "arm64", x64: "x64" }[os.arch()];
  if (!platform || !arch) {
    throw new Error(`unsupported host ${os.platform()}/${os.arch()}`);
  }
  return `${platform}-${arch}`;
}

function parseArgs(argv) {
  const options = {
    target: undefined,
    only: undefined,
    check: false,
    printHashes: false,
    clean: false,
    copyTo: undefined,
    sourceRoot: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--print-hashes") {
      options.printHashes = true;
    } else if (arg === "--clean") {
      options.clean = true;
    } else if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else if (arg.startsWith("--copy-to=")) {
      options.copyTo = arg.slice("--copy-to=".length);
    } else if (arg === "--copy-to") {
      options.copyTo = argv[++i];
    } else if (arg.startsWith("--source-root=")) {
      options.sourceRoot = arg.slice("--source-root=".length);
    } else if (arg === "--source-root") {
      options.sourceRoot = argv[++i];
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.copyTo === undefined && argv.includes("--copy-to")) {
    throw new Error("--copy-to requires a destination directory");
  }
  if (options.sourceRoot === undefined && argv.includes("--source-root")) {
    throw new Error("--source-root requires a directory");
  }
  if (options.sourceRoot && !options.copyTo) {
    throw new Error("--source-root requires --copy-to");
  }
  return options;
}

/** The extensions that have a build for `target`, filtered to `groups`. */
export function selectExtensions(target, groups) {
  const selected = [];
  for (const extension of curatedExtensions) {
    if (!groups.has(extension.group)) {
      continue;
    }
    const targetKey = targetKeyFor(extension, target);
    if (!targetKey) {
      throw new Error(
        `${extension.id} has no build for ${target}; add its checksum to curated-extensions.manifest.mjs`,
      );
    }
    selected.push({
      extension,
      targetKey,
      sha256: extension.targets[targetKey].sha256,
    });
  }
  return selected;
}

function sha256Of(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function vsixUrlFor(extension, targetKey) {
  const pinnedUrl = extension.targets[targetKey].url;
  if (pinnedUrl) {
    return pinnedUrl;
  }
  return openVsxUrl({
    namespace: extension.namespace,
    name: extension.name,
    version: extension.version,
    target: targetKey === "universal" ? undefined : targetKey,
  });
}

function cachePathFor(extension, targetKey) {
  const suffix = targetKey === "universal" ? "" : `@${targetKey}`;
  return path.join(
    CACHE_DIR,
    `${extension.id}-${extension.version}${suffix}.vsix`,
  );
}

/** Downloads to a temp file and renames, so a killed run never leaves a torn cache entry. */
async function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Open VSX answers with a 302 to its storage host; fetch follows by default.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed with ${response.status} ${response.statusText}`,
    );
  }
  const partial = `${destination}.part`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, destination);
}

async function ensureVsix(
  extension,
  targetKey,
  expectedSha,
  { allowDownload },
) {
  const cached = cachePathFor(extension, targetKey);
  if (!fs.existsSync(cached)) {
    if (!allowDownload) {
      throw new Error(
        `${extension.id}: ${cached} is missing and downloads are disabled`,
      );
    }
    await download(vsixUrlFor(extension, targetKey), cached);
  }
  const actual = sha256Of(cached);
  if (actual !== expectedSha) {
    // A mismatch means the pin is stale or the download was tampered with.
    // Drop the file so the next run refetches instead of failing forever.
    fs.rmSync(cached, { force: true });
    throw new Error(
      `${extension.id} checksum mismatch for ${targetKey}\n  expected ${expectedSha}\n  actual   ${actual}`,
    );
  }
  return cached;
}

function readStamp(directory) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(directory, STAMP_FILE), "utf8"),
    );
  } catch {
    return undefined;
  }
}

function stampMatches(stamp, extension, targetKey, sha256) {
  return (
    stamp?.id === extension.id &&
    stamp?.version === extension.version &&
    stamp?.target === targetKey &&
    stamp?.sha256 === sha256
  );
}

/**
 * VSIX payloads declare `dependencies` they ship prebundled and `scripts` that
 * only make sense in their own repo. Both confuse tooling that walks
 * extensions/*&#47;package.json (vsce's npm file listing in particular), so drop
 * them. `extensionPack` is dropped for extensions whose pack members Review
 * deliberately does not ship.
 */
function sanitizeManifest(directory, extension) {
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.scripts;
  delete manifest.dependencies;
  delete manifest.devDependencies;
  if (extension.stripExtensionPack) {
    delete manifest.extensionPack;
  }
  for (const activationEvent of extension.addActivationEvents ?? []) {
    manifest.activationEvents ??= [];
    if (!manifest.activationEvents.includes(activationEvent)) {
      manifest.activationEvents.push(activationEvent);
    }
  }
  const engine = manifest.engines?.vscode;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return { engine, id: `${manifest.publisher}.${manifest.name}` };
}

/** Fails loudly when a payload's layout drifts instead of shipping a broken server. */
function ensureExecutables(directory, extension) {
  for (const relative of extension.executables) {
    const executable = path.join(directory, relative);
    if (!fs.existsSync(executable)) {
      throw new Error(
        `${extension.id}: expected executable ${relative} is missing; the VSIX layout changed`,
      );
    }
    fs.chmodSync(executable, 0o755);
  }
}

function extractVsix(vsix, extension, targetKey, sha256) {
  const destination = path.join(EXTENSIONS_DIR, extension.id);
  const staging = `${destination}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    // System unzip preserves the unix mode bits that carry the executable
    // flag on bundled language servers.
    execFileSync("unzip", ["-q", vsix, "extension/*", "-d", staging], {
      stdio: "pipe",
    });
    const payload = path.join(staging, "extension");
    if (!fs.existsSync(payload)) {
      throw new Error(`${extension.id}: VSIX has no extension/ payload`);
    }
    const { engine, id } = sanitizeManifest(payload, extension);
    if (id.toLowerCase() !== extension.id.toLowerCase()) {
      throw new Error(
        `${extension.id}: VSIX declares a different identifier (${id})`,
      );
    }
    ensureExecutables(payload, extension);
    fs.writeFileSync(
      path.join(payload, STAMP_FILE),
      `${JSON.stringify({ id: extension.id, version: extension.version, target: targetKey, sha256, engine }, undefined, 2)}\n`,
    );
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(payload, destination);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}

function verifyEngine(directory, extension) {
  const stamp = readStamp(directory);
  const required = stamp?.engine;
  if (!required) {
    return;
  }
  const productVersion = JSON.parse(
    fs.readFileSync(path.join(CHECKOUT, "package.json"), "utf8"),
  ).version;
  const minimum = required.replace(/^[^\d]*/, "");
  if (!/^\d+\.\d+\.\d+$/.test(minimum)) {
    // A compound range would parse to NaN and silently satisfy the check below.
    throw new Error(
      `${extension.id} declares an engines.vscode range this check cannot compare: ${required}`,
    );
  }
  const cmp = (a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) {
        return (left[i] ?? 0) - (right[i] ?? 0);
      }
    }
    return 0;
  };
  if (cmp(productVersion, minimum) < 0) {
    throw new Error(
      `${extension.id} requires VS Code ${required} but this fork is ${productVersion}`,
    );
  }
}

/** Directories that are materialized for `target` within `groups`. */
export function materializedExtensionDirs(target, groups) {
  return selectExtensions(target, groups)
    .map(({ extension }) => path.join(EXTENSIONS_DIR, extension.id))
    .filter((directory) => fs.existsSync(directory));
}

/** Verifies the complete manifest-selected extension set at an arbitrary root. */
export function verifyCuratedExtensions({
  root,
  target,
  groups = parseGroupSelection(),
}) {
  for (const { extension, targetKey, sha256 } of selectExtensions(
    target,
    groups,
  )) {
    const directory = path.join(root, extension.id);
    if (!stampMatches(readStamp(directory), extension, targetKey, sha256)) {
      throw new Error(
        `${extension.id} is not materialized for ${target} at ${root}`,
      );
    }

    const manifestPath = path.join(directory, "package.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`${extension.id}: ${manifestPath} is missing`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    if (id !== extension.id.toLowerCase()) {
      throw new Error(`${extension.id}: packaged manifest declares ${id}`);
    }
    for (const field of ["dependencies", "devDependencies", "scripts"]) {
      if (manifest[field] !== undefined) {
        throw new Error(
          `${extension.id}: sanitized manifest still declares ${field}`,
        );
      }
    }
    if (extension.stripExtensionPack && manifest.extensionPack !== undefined) {
      throw new Error(
        `${extension.id}: sanitized manifest still declares extensionPack`,
      );
    }
    for (const activationEvent of extension.addActivationEvents ?? []) {
      if (!manifest.activationEvents?.includes(activationEvent)) {
        throw new Error(
          `${extension.id}: packaged manifest is missing ${activationEvent}`,
        );
      }
    }
    for (const relative of extension.executables) {
      const executable = path.join(directory, relative);
      if (!fs.existsSync(executable)) {
        throw new Error(
          `${extension.id}: expected executable ${relative} is missing`,
        );
      }
      if ((fs.statSync(executable).mode & 0o111) === 0) {
        throw new Error(`${extension.id}: ${relative} is not executable`);
      }
    }
    verifyEngine(directory, extension);
  }
}

export function copyCuratedExtensions({
  destinationRoot,
  sourceRoot = EXTENSIONS_DIR,
  target,
  groups = parseGroupSelection(),
}) {
  verifyCuratedExtensions({ root: sourceRoot, target, groups });
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const { extension, targetKey, sha256 } of selectExtensions(
    target,
    groups,
  )) {
    const source = path.join(sourceRoot, extension.id);
    const stamp = readStamp(source);
    if (!stampMatches(stamp, extension, targetKey, sha256)) {
      throw new Error(
        `${extension.id} is not materialized for ${target}; run without --copy-to first`,
      );
    }
    const destination = path.join(destinationRoot, extension.id);
    fs.rmSync(destination, { recursive: true, force: true });
    // cp -a keeps the executable bits on bundled language servers.
    execFileSync("cp", ["-a", source, destination], { stdio: "pipe" });
    ensureExecutables(destination, extension);
    console.log(`staged ${extension.id} -> ${destination}`);
  }
  verifyCuratedExtensions({ root: destinationRoot, target, groups });
}

async function printHashes(target) {
  for (const extension of curatedExtensions) {
    const targetKeys = extension.targets.universal
      ? ["universal"]
      : supportedTargets;
    for (const targetKey of targetKeys) {
      const cached = cachePathFor(extension, targetKey);
      if (!fs.existsSync(cached)) {
        await download(vsixUrlFor(extension, targetKey), cached);
      }
      console.log(`${extension.id} ${targetKey} ${sha256Of(cached)}`);
    }
  }
  void target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target ?? detectTarget();
  const groups = parseGroupSelection(options.only);

  if (options.printHashes) {
    await printHashes(target);
    return;
  }

  if (options.clean) {
    for (const extension of curatedExtensions) {
      fs.rmSync(path.join(EXTENSIONS_DIR, extension.id), {
        recursive: true,
        force: true,
      });
    }
    console.log("removed materialized curated extensions");
    return;
  }

  if (options.copyTo) {
    copyCuratedExtensions({
      destinationRoot: path.resolve(options.copyTo),
      sourceRoot: path.resolve(options.sourceRoot ?? EXTENSIONS_DIR),
      target,
      groups,
    });
    return;
  }

  if (!supportedTargets.includes(target)) {
    throw new Error(
      `unsupported target ${target}; expected one of ${supportedTargets.join(", ")}`,
    );
  }

  // Groups that were deselected should not linger from an earlier run, or the
  // picker would offer extensions this launch deliberately left out. --check is
  // read-only, so it never prunes.
  for (const extension of options.check ? [] : curatedExtensions) {
    if (!groups.has(extension.group)) {
      const stale = path.join(EXTENSIONS_DIR, extension.id);
      if (fs.existsSync(stale)) {
        fs.rmSync(stale, { recursive: true, force: true });
        console.log(
          `removed ${extension.id} (group ${extension.group} not selected)`,
        );
      }
    }
  }

  for (const { extension, targetKey, sha256 } of selectExtensions(
    target,
    groups,
  )) {
    const destination = path.join(EXTENSIONS_DIR, extension.id);
    if (stampMatches(readStamp(destination), extension, targetKey, sha256)) {
      verifyEngine(destination, extension);
      continue;
    }
    if (options.check) {
      throw new Error(`${extension.id} is not materialized for ${target}`);
    }
    const vsix = await ensureVsix(extension, targetKey, sha256, {
      allowDownload: !options.check,
    });
    extractVsix(vsix, extension, targetKey, sha256);
    verifyEngine(destination, extension);
    console.log(
      `materialized ${extension.id}@${extension.version} (${targetKey})`,
    );
  }
}

const require = createRequire(import.meta.url);
if (
  process.argv[1] &&
  require.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}

export { curatedGroups };
