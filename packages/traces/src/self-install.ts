import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import {
  AGENT_TRACE_HOOK_AGENTS,
  type AgentTraceHookAgent,
  disableTraceRepository,
  errorMessage,
  listTraceRepositoryRoots,
  removeAgentTraceHook,
  renderTraceCommand,
  traceRepositoryStatus,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { z } from "zod";

import { NODE_FLOOR_MAJOR } from "./node-floor.js";
import { readPackageVersion } from "./package-root.js";
import {
  ensureShellProfilePath,
  pathContainsDirectory,
  readTextIfExists,
  removeShellProfilePath,
  resolvePathCommand,
  shellProfilesWithPathSetup,
} from "./shell-profile.js";

/** The line that marks a command file as one this package wrote. */
export const SHIM_MARKER = "# Managed by @dev.fast/traces. Do not edit.";

/** The versions the install keeps beside the one in use. */
const KEEP_PREVIOUS_VERSIONS = 2;

const installStateSchema = z.object({
  version: z.string().min(1),
  installedAt: z.string().min(1),
  shimPath: z.string().min(1),
  runtimePath: z.string().min(1),
});

type InstallState = z.infer<typeof installStateSchema>;

/** The command file the install writes under the user's home directory. */
export function shimPath(homeDir: string): string {
  return path.join(homeDir, ".local", "bin", "dev-traces");
}

/** The directory that holds every installed version. */
export function tracesDir(devHome: string): string {
  return path.join(devHome, "traces");
}

/** The link that points at the installed version in use. */
export function currentLink(devHome: string): string {
  return path.join(tracesDir(devHome), "current");
}

/** The entry file of the installed version in use. */
export function currentCliPath(devHome: string): string {
  return path.join(currentLink(devHome), "dist", "cli.js");
}

/** The record of the last install this package wrote. */
export function installStatePath(devHome: string): string {
  return path.join(tracesDir(devHome), "install.json");
}

function versionsDir(devHome: string): string {
  return path.join(tracesDir(devHome), "versions");
}

export interface InstallSelfInput {
  packageRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
  execPath: string;
  force: boolean;
}

export interface InstallSelfResult {
  version: string;
  installedRoot: string;
  copied: boolean;
  shimPath: string;
  output: string;
}

export interface UninstallSelfInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
}

export interface UninstallSelfResult {
  removedShim: boolean;
  keptForeignShim: boolean;
  profiles: string[];
  hooksRemoved: AgentTraceHookAgent[];
  repositoriesDisabled: string[];
  output: string;
}

export interface SelfInstallStatusInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
  ownCliPath: string;
  runningVersion: string;
}

export interface SelfInstallStatus {
  installed: boolean;
  installedVersion: string | null;
  currentPath: string;
  shim: {
    path: string;
    present: boolean;
    owned: boolean;
    onPath: boolean;
    /** The shell files that put the shim directory on PATH in a new shell. */
    profiles: string[];
  };
  runtimePath: string | null;
  lines: string[];
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function sameRealPath(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(left).catch(() => null),
    realpath(right).catch(() => null),
  ]);

  return a !== null && a === b;
}

/** Quotes one word for `/bin/sh`, including a word that holds a quote. */
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The command file. It finds the installed entry through the trace home, picks
 * a runtime, and never breaks an agent session: a hook call exits 0 when the
 * install is gone, while a human call explains what to run.
 */
function shimSource(execPath: string): string {
  const baked = shSingleQuote(execPath);

  return `#!/bin/sh
${SHIM_MARKER}
home="\${DEV_REVIEW_HOME:-$HOME/.dev}"
cli="$home/traces/current/dist/cli.js"
hook_mode=0
if [ "$1" = "trace" ] && { [ "$2" = "hook" ] || [ "$2" = "git-hook" ]; }; then hook_mode=1; fi
if [ ! -f "$cli" ]; then
  [ "$hook_mode" = 1 ] && exit 0
  echo "dev-traces is not installed. Run: npx @dev.fast/traces install" >&2
  exit 1
fi
runtime=""
if [ -n "$DEV_TRACES_NODE" ] && [ -x "$DEV_TRACES_NODE" ]; then runtime="$DEV_TRACES_NODE"
elif [ -x ${baked} ]; then runtime=${baked}
elif command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case "$major" in *[!0-9]*|"") major=0;; esac
  [ "$major" -ge ${NODE_FLOOR_MAJOR} ] && runtime="node"
fi
if [ -z "$runtime" ]; then
  [ "$hook_mode" = 1 ] && exit 0
  echo "dev-traces needs Node.js ${NODE_FLOOR_MAJOR} or newer on PATH or in DEV_TRACES_NODE." >&2
  exit 1
fi
exec "$runtime" "$cli" "$@"
`;
}

async function writeShim(shim: string, execPath: string): Promise<void> {
  await mkdir(path.dirname(shim), { recursive: true });
  // writeFileAtomicAsync chmods the staged file to `mode` before the rename.
  await writeFileAtomicAsync(shim, shimSource(execPath), {
    encoding: "utf8",
    mode: 0o755,
    replaceSymlink: true,
  });
}

/** True when a name is taken, even by a symlink with no target. */
async function pathExists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(
    () => true,
    () => false,
  );
}

/**
 * Moves a command file this package did not write out of the way, so an
 * install never destroys a file of the user's own. Returns the backup path, or
 * null when the path is free or already holds a shim of ours.
 */
async function backupForeignShim(shim: string): Promise<string | null> {
  if (!(await pathExists(shim))) return null;

  if ((await readTextIfExists(shim)).includes(SHIM_MARKER)) return null;
  const base = `${shim}.bak-${Math.floor(Date.now() / 1000)}`;
  let backup = base;
  let counter = 1;

  while (await pathExists(backup)) {
    backup = `${base}-${counter}`;
    counter += 1;
  }

  await rename(shim, backup);

  return backup;
}

/**
 * Copies the package beside the installed versions. The copy leaves out every
 * node_modules directory: the bundle carries its dependencies, and the npx
 * cache the copy comes from disappears after the run.
 */
async function copyPackage(packageRoot: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });

  const previous = `${target}.old-${process.pid}`;
  await rm(previous, { recursive: true, force: true });

  // Set when the moved-aside copy is the only one left: the cleanup must not
  // remove it, and the error names it so the user can move it back.
  let keepPrevious = false;

  try {
    await cp(packageRoot, staging, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });

    // Two renames, never a delete: the target holds a complete copy at every
    // point, so a kill here cannot leave `current` pointing at nothing.
    const replaced = await rename(target, previous).then(
      () => true,
      () => false,
    );

    try {
      await rename(staging, target);
    } catch (error) {
      if (!replaced) throw error;

      const restored = await rename(previous, target).then(
        () => true,
        () => false,
      );

      if (restored) throw error;
      keepPrevious = true;

      throw new Error(
        `Could not install ${target}: ${errorMessage(error)}. The earlier version is at ${previous}; move it back to ${target}.`,
      );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });

    if (!keepPrevious) await rm(previous, { recursive: true, force: true });
  }
}

/** Points `current` at one version through a staged link and one rename. */
async function pointCurrent(devHome: string, version: string): Promise<void> {
  const link = currentLink(devHome);
  await mkdir(path.dirname(link), { recursive: true });
  const staging = `${link}.tmp-${process.pid}`;
  await rm(staging, { force: true });
  await symlink(path.join("versions", version), staging);
  await rename(staging, link);
}

/** The staging and set-aside names a killed install leaves behind. */
const LEFTOVER_NAME = /\.(?:tmp|old)-(\d+)$/;

/** True when a process with this id still runs, or the answer is unknown. */
function processRuns(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // ESRCH is the only answer that means the process is gone. EPERM means it
    // runs under another user, so the directory stays.
    // SAFETY: process.kill throws a Node system error, which carries `code`.
    const failure = error as NodeJS.ErrnoException;

    return failure.code !== "ESRCH";
  }
}

/** Removes the oldest versions, and never the one `current` points at. */
async function pruneVersions(devHome: string): Promise<string[]> {
  const root = versionsDir(devHome);
  const keep = await realpath(currentLink(devHome)).catch(() => null);
  const entries = await readdir(root).catch(() => []);
  const candidates: { dir: string; name: string; mtimeMs: number }[] = [];
  const removedLeftovers: string[] = [];

  for (const name of entries) {
    const leftover = LEFTOVER_NAME.exec(name);

    if (leftover) {
      // A kill leaves `<version>.tmp-<pid>` or `<version>.old-<pid>` behind.
      // Nothing reads it once its process is gone, so the prune removes it.
      if (!processRuns(Number(leftover[1]))) {
        await rm(path.join(root, name), { recursive: true, force: true });
        removedLeftovers.push(path.join(root, name));
      }

      continue;
    }

    const dir = path.join(root, name);

    if ((await realpath(dir).catch(() => null)) === keep) continue;
    const info = await stat(dir).catch(() => null);

    if (!info) continue;
    candidates.push({ dir, name, mtimeMs: info.mtimeMs });
  }

  // Newest first. Two copies can share one millisecond, so the name breaks
  // the tie and keeps the result the same on every machine.
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name),
  );

  const removed: string[] = [...removedLeftovers];

  for (const candidate of candidates.slice(KEEP_PREVIOUS_VERSIONS)) {
    await rm(candidate.dir, { recursive: true, force: true });
    removed.push(candidate.dir);
  }

  return removed;
}

/** True when the target holds a complete copy of the same version. */
async function installedAlready(
  target: string,
  version: string,
): Promise<boolean> {
  if (!(await exists(path.join(target, "dist", "cli.js")))) return false;

  return (await readPackageVersion(target).catch(() => null)) === version;
}

/** Copies the running package under the trace home and writes the shim. */
export async function installSelf(
  input: InstallSelfInput,
): Promise<InstallSelfResult> {
  const version = await readPackageVersion(input.packageRoot);
  const target = path.join(versionsDir(input.devHome), version);
  const shim = shimPath(input.homeDir);
  let copied = false;

  // A run of the installed copy installs nothing; it is already the target.
  if (!(await sameRealPath(input.packageRoot, target))) {
    if (input.force || !(await installedAlready(target, version))) {
      await copyPackage(input.packageRoot, target);
      copied = true;
    }
  }

  await pointCurrent(input.devHome, version);
  await pruneVersions(input.devHome);
  const backup = await backupForeignShim(shim);
  await writeShim(shim, input.execPath);

  const state: InstallState = {
    version,
    installedAt: new Date().toISOString(),
    shimPath: shim,
    runtimePath: input.execPath,
  };

  await writePrivateJsonAtomic(installStatePath(input.devHome), state);

  const profile = await ensureShellProfilePath({
    homeDir: input.homeDir,
    devHome: input.devHome,
    env: input.env,
    shimDirectory: path.dirname(shim),
  });

  // The probe runs on every install, even one that just wrote a shell file:
  // a new shell does not always put the shim directory first (macOS zsh runs
  // path_helper after .zshenv), so a command earlier on PATH still shadows
  // the shim. The npx `.bin` link is ruled out by its real path.
  const shadowing = await resolvePathCommand(
    "dev-traces",
    shim,
    input.env,
    SHIM_MARKER,
    await realpath(path.join(input.packageRoot, "dist", "cli.js")).catch(
      () => undefined,
    ),
  );

  const backupOutput = backup
    ? `[warn] moved your existing ~/.local/bin/dev-traces to ${backup}\n`
    : "";

  const shadowingOutput = shadowing
    ? `Warning: ${shadowing} currently shadows ${shim}. Move ${path.dirname(shim)} earlier in PATH.\n`
    : "";

  return {
    version,
    installedRoot: target,
    copied,
    shimPath: shim,
    output: `${backupOutput}[ok] dev-traces command -> ${shim}\n${profile.output}${shadowingOutput}`,
  };
}

/** Removes the shim, the installed versions, and the hooks they own. */
export async function uninstallSelf(
  input: UninstallSelfInput,
): Promise<UninstallSelfResult> {
  const shim = shimPath(input.homeDir);
  const shimText = await readTextIfExists(shim);
  const owned = shimText.includes(SHIM_MARKER);
  let removedShim = false;

  if (owned) {
    await rm(shim, { force: true });
    removedShim = true;
  }

  const profiles = await removeShellProfilePath({
    homeDir: input.homeDir,
    devHome: input.devHome,
    env: input.env,
  });

  const hooksRemoved: AgentTraceHookAgent[] = [];

  for (const agent of AGENT_TRACE_HOOK_AGENTS) {
    if (await removeAgentTraceHook(agent, input.homeDir, "dev-traces")) {
      hooksRemoved.push(agent);
    }
  }

  // Git hooks of another owner stay: only the repositories that re-enter this
  // shim lose their hooks. A state file without a command came from an older
  // `review`, so it stays as well.
  const ownCommand = renderTraceCommand({ file: shim });
  const repositoriesDisabled: string[] = [];
  const warnings: string[] = [];

  for (const root of await listTraceRepositoryRoots(input.homeDir)) {
    const status = await traceRepositoryStatus(root).catch(() => null);

    // No state file means no managed hooks, so there is nothing to remove.
    if (!status?.managedHooksPath) continue;

    if (status.command !== ownCommand) continue;

    const disabled = await disableTraceRepository({
      cwd: root,
      scope: {
        homeDir: input.homeDir,
        env: input.env,
        devHome: input.devHome,
      },
    }).then(
      () => true,
      (error) => {
        warnings.push(
          `[warn] could not disable the Git trace hooks in ${root}: ${errorMessage(error)}\n`,
        );

        return false;
      },
    );

    if (disabled) repositoriesDisabled.push(root);
  }

  await rm(tracesDir(input.devHome), { recursive: true, force: true });

  const foreignShimLine = shimText
    ? `[skip] ${shim} is not managed by @dev.fast/traces; left in place\n`
    : "";

  const lines = [
    removedShim ? `[ok] removed ${shim}\n` : foreignShimLine,
    ...profiles.map(
      (profile) => `[ok] removed the PATH setup from ${profile}\n`,
    ),
    ...hooksRemoved.map((agent) => `[ok] removed the ${agent} trace hook\n`),
    ...repositoriesDisabled.map(
      (root) => `[ok] disabled the Git trace hooks in ${root}\n`,
    ),
    ...warnings,
    `[ok] removed ${tracesDir(input.devHome)}\n`,
    "Kept: the trace store login, the repository consent, and the captured sessions.\n",
  ];

  return {
    removedShim,
    keptForeignShim: !owned && shimText.length > 0,
    profiles,
    hooksRemoved,
    repositoriesDisabled,
    output: lines.join(""),
  };
}

async function readInstallState(devHome: string): Promise<InstallState | null> {
  const text = await readTextIfExists(installStatePath(devHome));

  if (!text) return null;

  try {
    return installStateSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Reports the installed version, the shim, and the runtime in use. */
export async function selfInstallStatus(
  input: SelfInstallStatusInput,
): Promise<SelfInstallStatus> {
  const shim = shimPath(input.homeDir);
  const shimText = await readTextIfExists(shim);
  const currentPath = currentLink(input.devHome);
  const state = await readInstallState(input.devHome);
  const installed = await exists(currentCliPath(input.devHome));

  const installedVersion = installed
    ? await readPackageVersion(currentPath).catch(() => state?.version ?? null)
    : null;

  const status: SelfInstallStatus = {
    installed,
    installedVersion,
    currentPath,
    shim: {
      path: shim,
      present: shimText.length > 0,
      owned: shimText.includes(SHIM_MARKER),
      onPath: pathContainsDirectory(input.env.PATH, path.dirname(shim)),
      profiles: await shellProfilesWithPathSetup({
        homeDir: input.homeDir,
        devHome: input.devHome,
        env: input.env,
      }),
    },
    runtimePath: state?.runtimePath ?? null,
    lines: [],
  };

  status.lines.push(
    installed
      ? `Install: dev-traces ${installedVersion} at ${currentPath} (running ${input.runningVersion})\n`
      : `Install: not installed (running from ${input.ownCliPath})\n`,
  );

  const setUpIn =
    !status.shim.onPath && status.shim.profiles.length > 0
      ? `; set up in ${status.shim.profiles.join(", ")}`
      : "";

  status.lines.push(
    status.shim.present
      ? `Command: ${shim} (on PATH: ${status.shim.onPath ? "yes" : "no"}${setUpIn})\n`
      : `Command: ${shim} missing; run npx @dev.fast/traces install\n`,
  );

  if (status.runtimePath) status.lines.push(`Runtime: ${status.runtimePath}\n`);

  if (input.env.TRACE_DISABLE === "1") {
    status.lines.push("TRACE_DISABLE=1 is set; hooks are inert\n");
  }

  return status;
}
