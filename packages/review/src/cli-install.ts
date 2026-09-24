import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ReviewCliInstallStamp,
  ReviewCliInstallStampSchema,
  type ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import {
  AGENT_TRACE_HOOK_AGENTS,
  type TraceCredentialsInput,
  configureTraceMachine,
  describeTraceHookOwners,
  devReviewHome,
  disableAllTraceRepositories,
  disableTraceMachine,
  enableTraceRepository,
  installHarnessHooks,
  listTraceRepositoryRoots,
  removeAgentTraceHook,
  traceMachineEnabled,
  traceMachineStatus,
  traceRepositoryStatus,
  traceScope,
  withFileLock,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";

import { connectSetupPrompts, reviewMcpLaunch } from "./connect-prompts";
import { cursorInstallDeeplink } from "./cursor-deeplink";
import { isDirectory, isFile } from "./fs-utils";
import { removeLegacySkills, scanLegacySkills } from "./legacy-skills";
import { readReviewPackageVersion } from "./package-paths";
import { reviewDesktopStateDir } from "./review-home-paths";
import {
  updateWindowsUserPath,
  windowsCliShim,
  windowsUserPathContains,
} from "./windows-cli";

const installErrors = new Map<string, string>();

const SHIM_MARKER = "Managed by Whiteboard";

function hasManagedShimMarker(source: string): boolean {
  return (
    source.includes(SHIM_MARKER) ||
    source.includes("Managed by Review Desktop") ||
    source.includes("Managed by Whiteboard Desktop")
  );
}

const PROFILE_MARKER =
  "# Managed by Review Desktop: review command PATH. Do not edit.";

const PROFILE_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

const PROFILE_BLOCK = `\n${PROFILE_MARKER}\n${PROFILE_EXPORT}\n`;

const SHELL_PROFILE_NAMES = [".zprofile", ".bash_profile"] as const;

type ApplyResult = {
  code: number;
  output: string;
  shimPath?: string;
  userPath?: string;
};

export function cliInstallStampPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopStateDir(env), "cli-install.json");
}

/**
 * Present once this build's setup is current. It sits beside the stamp, not in
 * it, because older builds parse the stamp strictly and would drop a stamp
 * carrying a new key.
 */
export function cliInstallUpdateMarkerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopStateDir(env), "cli-install-updated");
}

export function pathShimPath(homeDir = os.homedir()): string {
  return path.join(
    homeDir,
    ".local",
    "bin",
    process.platform === "win32" ? "whiteboard.cmd" : "whiteboard",
  );
}

export async function resolveCliInstallStatus(input: {
  packageRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReviewCliInstallStatus> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const shimPath = pathShimPath(homeDir);
  const cliPath = path.join(input.packageRoot, "dist", "cli.js");

  const [fingerprint, stamp, updated, trace, legacySkills, cliBuilt, hasShim] =
    await Promise.all([
      installFingerprint(input.packageRoot),
      readCliInstallStamp(cliInstallStampPath(env)),
      isFile(cliInstallUpdateMarkerPath(env)),
      traceMachineStatus({ homeDir, env }),
      scanLegacySkills(homeDir),
      isFile(cliPath),
      isOwnedShim(shimPath),
    ]);

  const granted = stamp?.consent === "granted";

  const status: ReviewCliInstallStatus = {
    fingerprint,
    stamp,
    stale: granted && stamp.fingerprint !== fingerprint,
    updateNeeded: legacySkills.length > 0 || (granted && !updated),
    shim: {
      path: shimPath,
      installed: hasShim,
      profileConfigured:
        process.platform === "win32"
          ? (hasShim &&
              stamp?.userPath !== undefined &&
              sameWindowsPath(stamp.userPath, path.dirname(shimPath))) ||
            (await windowsUserPathContains(path.dirname(shimPath)))
          : await isShellProfileConfigured(homeDir),
      onPath: pathContainsDirectory(env.PATH, path.dirname(shimPath)),
    },
    trace,
    cli: cliBuilt
      ? {
          path: cliPath,
          version: readReviewPackageVersion(pathToFileURL(cliPath).href),
        }
      : null,
    connect: {
      ...reviewMcpLaunch(hasShim),
      prompts: connectSetupPrompts(),
      plugins: connectPlugins(hasShim),
    },
    legacySkills: legacySkills.map((skillPath) => ({
      path: homeRelative(homeDir, skillPath),
    })),
  };

  const error = installErrors.get(homeDir);

  if (error) status.error = error;

  return status;
}

interface ApplyCliInstallInput {
  packageRoot: string;
  shim?: boolean;
  autoUpdate?: boolean;
  trace?: true | TraceCredentialsInput;
  cliPath?: string;
  cliRuntimePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function applyCliInstall(
  input: ApplyCliInstallInput,
): Promise<ApplyResult> {
  if (!input.autoUpdate && input.shim !== true && input.trace === undefined)
    return { code: 0, output: "" };

  const homeDir = input.homeDir ?? os.homedir();

  try {
    const result = await withDesktopInstallLock(input.env, () =>
      input.autoUpdate
        ? resyncCliInstallUnlocked(input)
        : applyCliInstallUnlocked(input),
    );

    if (result.code === 0) installErrors.delete(homeDir);
    else installErrors.set(homeDir, result.output);

    return result;
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    installErrors.set(homeDir, output);

    return { code: 1, output };
  }
}

async function withDesktopInstallLock<T>(
  env: NodeJS.ProcessEnv = process.env,
  operation: () => Promise<T>,
): Promise<T> {
  const outcome = await withFileLock(
    `${cliInstallStampPath(env)}.lock`,
    { retryMs: 50, timeoutMs: 30_000, staleMs: 300_000, unownedGraceMs: 5_000 },
    operation,
  );

  if (!outcome.acquired)
    throw new Error(
      "Another Whiteboard setup operation is running. Retry shortly.",
    );

  return outcome.result;
}

/**
 * Silent app-update resync: rewrites the shim for the new build. Consent is
 * re-read under the lock, so a stale UI snapshot never reinstalls a command
 * the user has since removed or declined.
 */
async function resyncCliInstallUnlocked(
  input: ApplyCliInstallInput,
): Promise<ApplyResult> {
  const env = input.env ?? process.env;
  const stamp = await readCliInstallStamp(cliInstallStampPath(env));
  const fingerprint = await installFingerprint(input.packageRoot);

  if (stamp?.consent !== "granted" || stamp.fingerprint === fingerprint)
    return { code: 0, output: "" };

  const chunks: string[] = [];
  let shimPath: string | undefined;
  let userPath = stamp.userPath;

  if (stamp.shimPath && !stamp.commandDisabled) {
    const installed = await installShim(input, chunks);

    if (installed.code !== 0) return installed;
    shimPath = installed.shimPath;
    userPath = installed.userPath ?? userPath;
  }

  const next: ReviewCliInstallStamp = {
    ...stamp,
    fingerprint,
    updatedAt: new Date().toISOString(),
  };

  if (userPath) next.userPath = userPath;

  // The update marker stays as it was: an upgrader keeps `updateNeeded` until
  // Done.
  await writePrivateJsonAtomic(cliInstallStampPath(env), next);

  return withShimPath({ code: 0, output: chunks.join("") }, shimPath);
}

async function applyCliInstallUnlocked(
  input: ApplyCliInstallInput,
): Promise<ApplyResult> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const previous = await readCliInstallStamp(cliInstallStampPath(env));
  const granted = previous?.consent === "granted";
  const chunks: string[] = [];
  let traceEnabled = false;

  // Configure the machine before any other mutation, so a request with
  // missing credentials fails without a partial install.
  if (input.trace !== undefined) {
    try {
      const status = await configureTraceMachine({
        homeDir,
        env,
        credentials: input.trace === true ? undefined : input.trace,
      });

      traceEnabled = status.enabled;
      chunks.push(`[ok] trace capture -> ${status.envPath}\n`);

      if (status.error)
        chunks.push(`Trace storage check failed: ${status.error}\n`);
    } catch (cause) {
      chunks.push(
        `${cause instanceof Error ? cause.message : String(cause)}\n`,
      );

      return { code: 1, output: chunks.join("") };
    }
  }

  let shimPath: string | undefined;
  let userPath: string | undefined;

  if (input.shim === true) {
    const installed = await installShim(input, chunks);

    if (installed.code !== 0) return installed;
    shimPath = installed.shimPath;
    userPath = installed.userPath;
  }

  if (traceEnabled) {
    const executable = (await isOwnedShim(pathShimPath(homeDir)))
      ? pathShimPath(homeDir)
      : undefined;

    const hooks = await installHarnessHooks({ homeDir, env, executable });

    for (const hook of hooks.installed)
      chunks.push(`[ok] ${hook.agent} trace hook -> ${hook.path}\n`);
  }

  const stamp: ReviewCliInstallStamp = {
    consent: "granted",
    fingerprint: await installFingerprint(input.packageRoot),
    updatedAt: new Date().toISOString(),
  };

  const stampShimPath = shimPath ?? (granted ? previous.shimPath : undefined);

  if (stampShimPath) stamp.shimPath = stampShimPath;

  if (granted && previous.commandDisabled && input.shim !== true)
    stamp.commandDisabled = true;

  if (input.trace !== undefined || (granted && previous.traceManaged))
    stamp.traceManaged = true;

  const stampUserPath =
    userPath ?? (granted && !shimPath ? previous.userPath : undefined);

  if (stampUserPath) stamp.userPath = stampUserPath;

  await writeCurrentStamp(env, stamp);

  return withShimPath({ code: 0, output: chunks.join("") }, shimPath);
}

async function installShim(
  input: ApplyCliInstallInput,
  chunks: string[],
): Promise<ApplyResult> {
  if (!input.cliPath) {
    chunks.push("This server has no built CLI to install the command from.\n");

    return { code: 1, output: chunks.join("") };
  }

  const installed = await installReviewCommand({
    cliPath: input.cliPath,
    cliRuntimePath: input.cliRuntimePath,
    homeDir: input.homeDir,
    env: input.env,
  });

  chunks.push(installed.output);

  const result: ApplyResult = {
    code: 0,
    output: "",
    shimPath: installed.shimPath,
  };

  if (installed.userPath) result.userPath = installed.userPath;

  return result;
}

function withShimPath(
  result: ApplyResult,
  shimPath: string | undefined,
): ApplyResult {
  if (shimPath) result.shimPath = shimPath;

  return result;
}

/** The published plugin per harness; Cursor's link needs the shim it launches. */
function connectPlugins(
  hasShim: boolean,
): ReviewCliInstallStatus["connect"]["plugins"] {
  return {
    claude: {
      label: "Install the Claude Code plugin",
      command:
        "/plugin marketplace add devdotfast/whiteboard\n/plugin install whiteboard@devfast",
    },
    codex: {
      label: "Install the Codex plugin",
      command:
        "codex plugin marketplace add devdotfast/whiteboard\ncodex plugin add whiteboard@devfast",
    },
    cursor: hasShim
      ? {
          label: "Install in Cursor",
          url: cursorInstallDeeplink(reviewMcpLaunch(true)),
        }
      : { label: "Install in Cursor" },
    opencode: {
      label: "Install the OpenCode plugin",
      command:
        'Add "@dev.fast/opencode-whiteboard" to "plugin" in ~/.config/opencode/opencode.json,\nthen quit and reopen OpenCode to load it.',
    },
    pi: {
      label: "Install the Pi package",
      command: "pi install npm:@dev.fast/pi-whiteboard",
    },
    omp: {
      label: "Install the oh-my-pi package",
      command: "omp install npm:@dev.fast/pi-whiteboard",
    },
  };
}

/** Removes the skills Whiteboard Desktop installed before it connected over MCP. */
export async function removeLegacyReviewSkills(
  input: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ removed: string[] }> {
  return withDesktopInstallLock(input.env, () =>
    removeLegacySkills(input.homeDir ?? os.homedir()),
  );
}

/** Records setup completion; remaining legacy skills still require the update screen. */
export async function finishCliInstallUpdate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, async () => {
    const stamp = await readCliInstallStamp(cliInstallStampPath(env));

    if (stamp?.consent !== "granted") return;
    await writeUpdateMarker(env);
  });
}

export async function declineCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, () =>
    writeCurrentStamp(env, {
      consent: "declined",
      updatedAt: new Date().toISOString(),
    }),
  );
}

export async function skipCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, async () => {
    const stampPath = cliInstallStampPath(env);

    if (await readCliInstallStamp(stampPath)) return;
    await writeCurrentStamp(env, {
      consent: "skipped",
      updatedAt: new Date().toISOString(),
    });
  });
}

/** Removes the stamp entirely, so the next app launch prompts again. */
export async function resetCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, async () => {
    await rm(cliInstallStampPath(env), { force: true });
    await rm(cliInstallUpdateMarkerPath(env), { force: true });
  });
}

/** Writes a stamp this build decided, which also makes the setup current. */
async function writeCurrentStamp(
  env: NodeJS.ProcessEnv,
  stamp: ReviewCliInstallStamp,
): Promise<void> {
  await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);
  await writeUpdateMarker(env);
}

async function writeUpdateMarker(env: NodeJS.ProcessEnv): Promise<void> {
  await writeFileAtomicAsync(cliInstallUpdateMarkerPath(env), "", {
    encoding: "utf8",
    mode: 0o600,
  });
}

interface RemoveCliInstallInput {
  shim?: boolean;
  trace?: boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function removeCliInstall(
  input: RemoveCliInstallInput,
): Promise<{ output: string }> {
  return withDesktopInstallLock(input.env, () =>
    removeCliInstallUnlocked(input),
  );
}

async function removeCliInstallUnlocked(
  input: RemoveCliInstallInput,
): Promise<{ output: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const chunks: string[] = [];

  const expectedTraceCommand = (await isOwnedShim(pathShimPath(homeDir)))
    ? pathShimPath(homeDir)
    : "";

  const previous = await readCliInstallStamp(cliInstallStampPath(env));

  if (input.shim) {
    const shimPath = pathShimPath(homeDir);
    // Only ever delete a command file this app wrote; a hand-made file at
    // the same path stays untouched.
    const contents = await readTextIfExists(shimPath);

    if (contents.includes(SHIM_MARKER)) {
      await rm(shimPath, { force: true });

      if (process.platform === "win32") {
        const bashShim = shimPath.replace(/\.cmd$/i, "");

        if (await isOwnedShim(bashShim)) await rm(bashShim, { force: true });
      }

      chunks.push(`[ok] removed whiteboard command ${shimPath}\n`);
    } else if (contents) {
      chunks.push(
        `${shimPath} was not installed by Whiteboard Desktop; left in place.\n`,
      );
    }

    for (const profilePath of await removeShellProfilePath(homeDir)) {
      chunks.push(`[ok] removed Review PATH entry from ${profilePath}\n`);
    }
  }

  if (input.trace) {
    const { kept } = await disableAllTraceRepositories(
      traceScope({ homeDir, env }),
      expectedTraceCommand,
    );

    for (const agent of AGENT_TRACE_HOOK_AGENTS)
      await removeAgentTraceHook(agent, homeDir, env, expectedTraceCommand);

    const remaining = await describeTraceHookOwners(homeDir, env);

    if (kept.length || Object.values(remaining).some(Boolean)) {
      chunks.push(
        "[skip] kept trace capture for another Whiteboard installation\n",
      );
    } else {
      await disableTraceMachine({ homeDir, env });
      chunks.push("[ok] disabled Whiteboard trace capture\n");
    }
  }

  if (previous?.consent === "granted") {
    const stamp: ReviewCliInstallStamp = {
      consent: "granted",
      updatedAt: new Date().toISOString(),
    };

    if (previous.fingerprint) stamp.fingerprint = previous.fingerprint;

    if (!input.shim && previous.shimPath) stamp.shimPath = previous.shimPath;

    if (input.shim || previous.commandDisabled) stamp.commandDisabled = true;

    if (!input.trace && previous.traceManaged) stamp.traceManaged = true;

    if (!input.shim && previous.userPath) stamp.userPath = previous.userPath;
    await writeCurrentStamp(env, stamp);
  }

  return { output: chunks.join("") };
}

/**
 * Fingerprint of the package manifest and built CLI. Content-based so it
 * works identically in a dev checkout and a packaged review-runtime, with no
 * build-time stamping.
 */
export async function installFingerprint(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readTextIfExists(path.join(packageRoot, "package.json")));
  hash.update("dist/cli.js\0");
  hash.update(await readTextIfExists(path.join(packageRoot, "dist", "cli.js")));

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

export async function isOwnedShim(shimPath: string): Promise<boolean> {
  return hasManagedShimMarker(await readTextIfExists(shimPath));
}

/**
 * The shim is POSIX sh, so running `review` needs no Node.js at all to start.
 * It prefers the CLI and runtime the running Whiteboard Desktop advertises in its
 * discovery file, falls back to the paths baked in by the app that wrote it,
 * and runs the CLI under the app's Electron binary as Node
 * (ELECTRON_RUN_AS_NODE) — the exact runtime the server uses. System Node is
 * the last resort and gets a clear version check instead of a cryptic crash.
 */
export async function writePathShim(
  shimPath: string,
  cliPath: string,
  runtimePath: string | undefined,
  devHome: string,
): Promise<void> {
  if (process.platform === "win32") {
    await writeFileAtomicAsync(
      shimPath,
      windowsCliShim(cliPath, runtimePath ?? process.execPath, devHome),
      { replaceSymlink: true },
    );

    // Git Bash and agent plugins use the POSIX launcher beside the .cmd file.
    shimPath = shimPath.replace(/\.cmd$/i, "");
  }

  const source = `#!/bin/sh
# Managed by Whiteboard Desktop ("Review: Install CLI in PATH"). Do not edit.
FALLBACK_CLI=${shSingleQuote(cliPath)}
FALLBACK_RUNTIME=${shSingleQuote(runtimePath ?? "")}
DEFAULT_HOME=${shSingleQuote(devHome)}
export DEV_REVIEW_HOME="\${DEV_REVIEW_HOME:-$DEFAULT_HOME}"
DESKTOP="$DEV_REVIEW_HOME/review-desktop"

# A record counts only while its server process is alive.
live() {
  [ -f "$1" ] || return 1
  pid=$(sed -n 's/.*"serverPid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$1" | head -n 1)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Same order as the CLI: DEV_REVIEW_INSTANCE, the machine default, the only
# live Desktop, then stable. A stable Desktop that predates instances wrote
# only server.json; it never stands in for any other key.
LEGACY="$DESKTOP/server.json"
STABLE="$DESKTOP/instances/stable.json"
[ -f "$STABLE" ] || STABLE="$LEGACY"
key="\${DEV_REVIEW_INSTANCE:-}"
if [ -z "$key" ] && [ -f "$DESKTOP/default-instance" ]; then
  key=$(head -n 1 "$DESKTOP/default-instance" | tr -d '[:space:]')
fi
DISCOVERY=""
case "$key" in
  # Keys name files; the CLI rejects anything else.
  *[!A-Za-z0-9_.-]*) ;;
  stable) DISCOVERY="$STABLE" ;;
  ?*) DISCOVERY="$DESKTOP/instances/$key.json" ;;
  *)
    for record in "$DESKTOP"/instances/*.json "$LEGACY"; do
      if [ "$record" = "$LEGACY" ] && [ "$STABLE" != "$LEGACY" ]; then continue; fi
      if live "$record"; then
        if [ -n "$DISCOVERY" ]; then DISCOVERY=""; break; fi
        DISCOVERY="$record"
      fi
    done
    [ -n "$DISCOVERY" ] || DISCOVERY="$STABLE"
    ;;
esac

cli=""
runtime=""
delegated=""
manage_instances=""
for arg in "$@"; do
  if [ "$arg" = "instances" ]; then manage_instances=1; break; fi
done
if [ -z "$manage_instances" ] && [ -z "\${DEV_FAST_REVIEW_CLI_NO_DELEGATE:-}" ] && live "$DISCOVERY"; then
  cli=$(sed -n 's/.*"cliPath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$DISCOVERY" | head -n 1)
  delegated="1"
  runtime=$(sed -n 's/.*"cliRuntimePath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$DISCOVERY" | head -n 1)
fi
if [ -z "$cli" ] || [ ! -f "$cli" ] || { [ -n "$runtime" ] && [ ! -x "$runtime" ]; }; then
  delegated=""
  cli="$FALLBACK_CLI"
  runtime="$FALLBACK_RUNTIME"
fi

if [ ! -f "$cli" ]; then
  echo "Whiteboard CLI not found at $cli. Start Whiteboard Desktop, or run npx @dev.fast/review instead." >&2
  exit 1
fi

# Prevent bootstrap from overriding this selection.
export DEV_FAST_REVIEW_CLI_NO_DELEGATE=1
export DEV_FAST_REVIEW_CLI_DELEGATED="$delegated"

# The app's Electron binary runs as plain Node.js and matches the server's
# runtime exactly; no system Node is required on this path.
if [ -n "$runtime" ] && [ -x "$runtime" ]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$runtime" "$cli" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Whiteboard needs Node.js 24 or newer and none was found. Install Node 24, or install Whiteboard Desktop." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$major" in *[!0-9]*) major=0;; esac
if [ "$major" -lt 24 ]; then
  echo "Whiteboard needs Node.js 24 or newer; found $(node -v 2>/dev/null). Update Node, or install Whiteboard Desktop." >&2
  exit 1
fi
exec node "$cli" "$@"
`;

  await writeFileAtomicAsync(shimPath, source, {
    encoding: "utf8",
    mode: 0o755,
    replaceSymlink: true,
  });
  await chmod(shimPath, 0o755);
}

export async function installReviewCommand(input: {
  cliPath: string;
  cliRuntimePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ shimPath: string; output: string; userPath?: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const shimPath = pathShimPath(homeDir);

  if ((await isFile(shimPath)) && !(await isOwnedShim(shimPath))) {
    return {
      shimPath,
      output: `[skip] kept the existing whiteboard command at ${shimPath}\n`,
    };
  }

  const shadowingCommand = await resolvePathCommand(
    "whiteboard",
    shimPath,
    env,
  );

  await writePathShim(
    shimPath,
    input.cliPath,
    input.cliRuntimePath,
    devReviewHome(env, homeDir),
  );

  if (await traceMachineEnabled({ homeDir, env })) {
    const scope = traceScope({ homeDir, env });

    for (const cwd of await listTraceRepositoryRoots(homeDir)) {
      if (!(await isDirectory(cwd))) continue;

      if ((await traceRepositoryStatus(cwd)).enabled)
        await enableTraceRepository({
          cwd,
          scope,
          reviewCommand: shimPath,
          replaceCommand: true,
        });
    }
  }

  const legacyShim = path.join(path.dirname(shimPath), "review");

  if (await isOwnedShim(legacyShim)) await rm(legacyShim, { force: true });
  const profileOutput = await ensureShellProfilePath({ homeDir, env });

  const shadowingOutput = shadowingCommand
    ? `Warning: ${shadowingCommand} currently shadows ${shimPath}. Remove that PATH entry or put ${path.dirname(shimPath)} before it.\n`
    : "";

  const output = `[ok] whiteboard command -> ${shimPath}\n${profileOutput}${shadowingOutput}`;

  // ensureShellProfilePath throws when the Windows PATH write fails, so
  // reaching here means new terminals will find the command.
  return process.platform === "win32"
    ? { shimPath, output, userPath: path.dirname(shimPath) }
    : { shimPath, output };
}

export async function ensureShellProfilePath(input: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const shimDirectory = path.dirname(pathShimPath(input.homeDir));

  if (pathContainsDirectory(input.env.PATH, shimDirectory)) return "";

  if (process.platform === "win32") {
    await updateWindowsUserPath(shimDirectory);

    return `[ok] added ${shimDirectory} to your user PATH; open a new terminal\n`;
  }

  const shell = path.basename(input.env.SHELL?.trim() ?? "");
  let profileName: (typeof SHELL_PROFILE_NAMES)[number] | undefined;

  if (shell === "bash") {
    profileName = ".bash_profile";
  } else if (
    shell === "zsh" ||
    (shell !== "fish" && process.platform === "darwin")
  ) {
    profileName = ".zprofile";
  }

  if (!profileName) {
    return "Whiteboard did not update PATH for this shell. Add ~/.local/bin to PATH. Fish users can run: fish_add_path ~/.local/bin\n";
  }

  const profilePath = path.join(input.homeDir, profileName);
  const source = await readTextIfExists(profilePath);

  if (source.includes(PROFILE_MARKER) || source.includes(".local/bin")) {
    return "";
  }

  await writeTextAtomic(profilePath, `${source}${PROFILE_BLOCK}`);

  return `[ok] added ${shimDirectory} to PATH in ${profilePath}\n`;
}

export async function removeShellProfilePath(
  homeDir: string,
): Promise<string[]> {
  if (process.platform === "win32") {
    await updateWindowsUserPath(path.dirname(pathShimPath(homeDir)), true);

    return ["user PATH"];
  }

  const removed: string[] = [];

  for (const profileName of SHELL_PROFILE_NAMES) {
    const profilePath = path.join(homeDir, profileName);
    const source = await readTextIfExists(profilePath);

    if (!source.includes(PROFILE_BLOCK)) continue;
    await writeTextAtomic(profilePath, source.replaceAll(PROFILE_BLOCK, ""));
    removed.push(profilePath);
  }

  return removed;
}

function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function resolvePathCommand(
  command: string,
  shimPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const entries = (env.PATH ?? "").split(path.delimiter);
  const shimDirectory = path.resolve(path.dirname(shimPath));

  const shimIndex = entries.findIndex(
    (entry) => path.resolve(entry || ".") === shimDirectory,
  );

  for (let index = 0; index < entries.length; index += 1) {
    const candidate = path.join(entries[index] || ".", command);

    if (!(await isExecutableFile(candidate))) continue;

    if ((await readTextIfExists(candidate)).includes(SHIM_MARKER)) {
      return undefined;
    }

    return shimIndex === -1 || index < shimIndex
      ? path.resolve(candidate)
      : undefined;
  }

  return undefined;
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    path.win32.resolve(left).toLowerCase() ===
    path.win32.resolve(right).toLowerCase()
  );
}

function pathContainsDirectory(
  pathValue: string | undefined,
  directory: string,
): boolean {
  return (pathValue ?? "")
    .split(path.delimiter)
    .some(
      (entry) =>
        entry.length > 0 && path.resolve(entry) === path.resolve(directory),
    );
}

async function isShellProfileConfigured(homeDir: string): Promise<boolean> {
  const profiles = await Promise.all(
    SHELL_PROFILE_NAMES.map((profileName) =>
      readTextIfExists(path.join(homeDir, profileName)),
    ),
  );

  return profiles.some((source) => source.includes(PROFILE_MARKER));
}

async function writeTextAtomic(
  filePath: string,
  source: string,
): Promise<void> {
  let mode = 0o644;

  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    // Use the default profile mode for a new file.
  }

  await writeFileAtomicAsync(filePath, source, { encoding: "utf8", mode });
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function isExecutableFile(target: string): Promise<boolean> {
  if (!(await isFile(target))) return false;

  try {
    await access(target, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** `~/…` for paths under the home directory; the card shows these, removal rescans. */
function homeRelative(homeDir: string, target: string): string {
  const relative = path.relative(homeDir, target);

  return relative.startsWith("..") || path.isAbsolute(relative)
    ? target
    : `~/${relative.split(path.sep).join("/")}`;
}
