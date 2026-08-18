import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ReviewCliInstallStamp,
  ReviewCliInstallStampSchema,
  type ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";

import {
  ALL_INSTALL_TARGETS,
  type InstallTarget,
  detectInstalledTargets,
  removeInstalledSkills,
  runInstall,
} from "../install";
import { readProgressiveReviewPackageVersion } from "../package-paths";
import { reviewDesktopStateDir, writePrivateJsonAtomic } from "./desktop-paths";

const AGENT_HOME_DIR: Record<InstallTarget, string> = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
};

export function cliInstallStampPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopStateDir(env), "cli-install.json");
}

export function pathShimPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".local", "bin", "review");
}

export async function resolveCliInstallStatus(input: {
  packageRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReviewCliInstallStatus> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const [present, installed, fingerprint, stamp] = await Promise.all([
    detectPresentAgents(homeDir),
    detectInstalledTargets(homeDir),
    installFingerprint(input.packageRoot),
    readCliInstallStamp(cliInstallStampPath(env)),
  ]);
  const installedSet = new Set(installed);
  const shimPath = pathShimPath(homeDir);
  const cliPath = path.join(input.packageRoot, "dist", "cli.js");
  return {
    agents: ALL_INSTALL_TARGETS.map((target) => ({
      target,
      present: present.has(target),
      installed: installedSet.has(target),
    })),
    fingerprint,
    stamp,
    stale: stamp?.consent === "granted" && stamp.fingerprint !== fingerprint,
    shim: {
      path: shimPath,
      onPath: (env.PATH ?? "")
        .split(path.delimiter)
        .some(
          (entry) => entry && path.resolve(entry) === path.dirname(shimPath),
        ),
    },
    cli: (await isFile(cliPath))
      ? {
          path: cliPath,
          version: readProgressiveReviewPackageVersion(
            pathToFileURL(cliPath).href,
          ),
        }
      : null,
  };
}

export async function applyCliInstall(input: {
  packageRoot: string;
  targets: InstallTarget[];
  shim?: boolean;
  cliPath?: string;
  cliRuntimePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; output: string; shimPath?: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const chunks: string[] = [];
  const sink = {
    write: (chunk: string) => (chunks.push(chunk), true),
  } as NodeJS.WriteStream;
  if (input.targets.length > 0) {
    const code = await runInstall({
      targets: input.targets,
      homeDir,
      packageRoot: input.packageRoot,
      stdout: sink,
      stderr: sink,
    });
    if (code !== 0) return { code, output: chunks.join("") };
  }

  let shimPath: string | undefined;
  if (input.shim) {
    if (!input.cliPath) {
      chunks.push(
        "This server has no built CLI to install the command from.\n",
      );
      return { code: 1, output: chunks.join("") };
    }
    shimPath = pathShimPath(homeDir);
    await writePathShim(shimPath, input.cliPath, input.cliRuntimePath);
    chunks.push(`[ok] review command -> ${shimPath}\n`);
  }

  // The stamp is cumulative app-managed state: installing skills for one
  // agent must not drop other stamped agents or the command from re-sync.
  const previous = await readCliInstallStamp(cliInstallStampPath(env));
  const previousTargets =
    previous?.consent === "granted" ? (previous.targets ?? []) : [];
  const previousShimPath =
    previous?.consent === "granted" ? previous.shimPath : undefined;
  const stampShimPath = shimPath ?? previousShimPath;
  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "granted",
    fingerprint: await installFingerprint(input.packageRoot),
    targets: [...new Set([...previousTargets, ...input.targets])],
    ...(stampShimPath ? { shimPath: stampShimPath } : {}),
    updatedAt: new Date().toISOString(),
  } satisfies ReviewCliInstallStamp);
  return {
    code: 0,
    output: chunks.join(""),
    ...(shimPath ? { shimPath } : {}),
  };
}

export async function declineCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "declined",
    updatedAt: new Date().toISOString(),
  } satisfies ReviewCliInstallStamp);
}

export async function skipCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stampPath = cliInstallStampPath(env);
  if (await readCliInstallStamp(stampPath)) return;
  await writePrivateJsonAtomic(stampPath, {
    consent: "skipped",
    updatedAt: new Date().toISOString(),
  } satisfies ReviewCliInstallStamp);
}

/** Removes the stamp entirely, so the next app launch prompts again. */
export async function resetCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(cliInstallStampPath(env), { force: true });
}

const SHIM_MARKER = "Managed by Review Desktop";

export async function removeCliInstall(input: {
  targets: InstallTarget[];
  shim?: boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ output: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const chunks: string[] = [];
  for (const target of input.targets) {
    await removeInstalledSkills(target, homeDir);
    chunks.push(`[ok] removed skills for ${target}\n`);
  }

  if (input.shim) {
    const shimPath = pathShimPath(homeDir);
    // Only ever delete a command file this app wrote; a hand-made file at
    // the same path stays untouched.
    const contents = await readTextIfExists(shimPath);
    if (contents.includes(SHIM_MARKER)) {
      await rm(shimPath, { force: true });
      chunks.push(`[ok] removed review command ${shimPath}\n`);
    } else if (contents) {
      chunks.push(
        `${shimPath} was not installed by Review Desktop; left in place.\n`,
      );
    }
  }

  const previous = await readCliInstallStamp(cliInstallStampPath(env));
  if (previous?.consent === "granted") {
    const removed = new Set(input.targets);
    const targets = (previous.targets ?? []).filter(
      (target) => !removed.has(target),
    );
    const shimPath = input.shim ? undefined : previous.shimPath;
    await writePrivateJsonAtomic(cliInstallStampPath(env), {
      consent: "granted",
      ...(previous.fingerprint ? { fingerprint: previous.fingerprint } : {}),
      targets,
      ...(shimPath ? { shimPath } : {}),
      updatedAt: new Date().toISOString(),
    } satisfies ReviewCliInstallStamp);
  }
  return { output: chunks.join("") };
}

/**
 * Fingerprint of everything the app distributes: the package version, the
 * built CLI, and the skill sources. Content-based so it works identically in
 * a dev checkout and a packaged review-runtime, with no build-time stamping.
 */
export async function installFingerprint(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readTextIfExists(path.join(packageRoot, "package.json")));
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  hash.update("dist/cli.js\0");
  hash.update(await readTextIfExists(cliPath));
  for (const file of await listFilesRecursive(
    path.join(packageRoot, "skills"),
  )) {
    hash.update(`${file.relPath}\0`);
    hash.update(await readFile(file.absPath));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 20);
}

export async function readCliInstallStamp(
  stampPath: string,
): Promise<ReviewCliInstallStamp | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(stampPath, "utf8"));
  } catch {
    return null;
  }
  const parsed = ReviewCliInstallStampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function detectPresentAgents(
  homeDir: string,
): Promise<Set<InstallTarget>> {
  const present = new Set<InstallTarget>();
  await Promise.all(
    ALL_INSTALL_TARGETS.map(async (target) => {
      if (await isDirectory(path.join(homeDir, AGENT_HOME_DIR[target]))) {
        present.add(target);
      }
    }),
  );
  return present;
}

/**
 * The shim is POSIX sh, so running `review` needs no Node.js at all to start.
 * It prefers the CLI and runtime the running Review Desktop advertises in its
 * discovery file, falls back to the paths baked in by the app that wrote it,
 * and runs the CLI under the app's Electron binary as Node
 * (ELECTRON_RUN_AS_NODE) — the exact runtime the server uses. System Node is
 * the last resort and gets a clear version check instead of a cryptic crash.
 */
export async function writePathShim(
  shimPath: string,
  cliPath: string,
  runtimePath?: string,
): Promise<void> {
  const source = `#!/bin/sh
# Managed by Review Desktop ("Review: Manage CLI and Skills..."). Do not edit.
FALLBACK_CLI=${shSingleQuote(cliPath)}
FALLBACK_RUNTIME=${shSingleQuote(runtimePath ?? "")}
DISCOVERY="\${DEV_REVIEW_HOME:-$HOME/.dev}/review-desktop/server.json"

cli=""
runtime=""
if [ -f "$DISCOVERY" ]; then
  cli=$(sed -n 's/.*"cliPath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$DISCOVERY" | head -n 1)
  runtime=$(sed -n 's/.*"cliRuntimePath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$DISCOVERY" | head -n 1)
fi
if [ -z "$cli" ] || [ ! -f "$cli" ]; then cli="$FALLBACK_CLI"; fi
if [ -z "$runtime" ] || [ ! -x "$runtime" ]; then runtime="$FALLBACK_RUNTIME"; fi

if [ ! -f "$cli" ]; then
  echo "Review CLI not found at $cli. Start Review Desktop, or run npx @dev.fast/review instead." >&2
  exit 1
fi

# The app's Electron binary runs as plain Node.js and matches the server's
# runtime exactly; no system Node is required on this path.
if [ -n "$runtime" ] && [ -x "$runtime" ]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$runtime" "$cli" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Review needs Node.js 24 or newer and none was found. Install Node 24, or install Review Desktop." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$major" in *[!0-9]*) major=0;; esac
if [ "$major" -lt 24 ]; then
  echo "Review needs Node.js 24 or newer; found $(node -v 2>/dev/null). Update Node, or install Review Desktop." >&2
  exit 1
fi
exec node "$cli" "$@"
`;
  await mkdir(path.dirname(shimPath), { recursive: true });
  const staging = `${shimPath}.tmp-${process.pid}`;
  try {
    await writeFile(staging, source, { encoding: "utf8", mode: 0o755 });
    await rename(staging, shimPath);
  } finally {
    await rm(staging, { force: true });
  }
  await chmod(shimPath, 0o755);
}

function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function listFilesRecursive(
  root: string,
): Promise<{ relPath: string; absPath: string }[]> {
  const files: { relPath: string; absPath: string }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absPath);
      else if (entry.isFile()) {
        files.push({ relPath: path.relative(root, absPath), absPath });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
