import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ReviewCliInstallStamp,
  ReviewCliInstallStampSchema,
  type ReviewCliInstallStatus,
  type ReviewFffInstallTarget,
  type ReviewFffManagedRegistration,
} from "@dev.fast/review-protocol";
import {
  type TraceCredentialsInput,
  collectingWritable,
  disableAllTraceRepositories,
  disableTraceMachine,
  removeAgentTraceHook,
  traceMachineStatus,
  traceScope,
  withFileLock,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";

import {
  FFF_SERVER_NAME,
  FFF_TARGETS,
  fffBinaryPath,
  fffCorpusRoot,
  fffRegistration,
  fffRegistrationMatches,
  isFffTarget,
  readFffRegistration,
  removeFffRegistration,
} from "./agent-fff";
import {
  REVIEW_MCP_TARGETS,
  reviewMcpLauncher,
  reviewMcpRegistration,
  reviewMcpStatus,
  writeReviewMcpRegistration,
} from "./agent-review-mcp";
import { isDirectory, isFile } from "./fs-utils";
import {
  ALL_INSTALL_TARGETS,
  type InstallTarget,
  detectInstalledTargets,
  removeInstalledSkills,
  removeTraceSkills,
  resolveInstalledSkills,
  runInstall,
} from "./install";
import { readReviewPackageVersion } from "./package-paths";
import { reviewDesktopStateDir } from "./review-home-paths";

const installErrors = new Map<string, string>();

const AGENT_HOME_DIR: Record<InstallTarget, string> = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
  opencode: ".config/opencode",
  pi: ".pi",
};

const SHIM_MARKER = "Managed by Review Desktop";

const PROFILE_MARKER =
  "# Managed by Review Desktop: review command PATH. Do not edit.";

const PROFILE_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

const PROFILE_BLOCK = `\n${PROFILE_MARKER}\n${PROFILE_EXPORT}\n`;

const SHELL_PROFILE_NAMES = [".zprofile", ".bash_profile"] as const;

const SHADOWING_HELP_URL =
  "https://github.com/devdotfast/review/blob/main/docs/troubleshooting.md#the-command-opens-a-browser-or-shows-old-options";

export function cliInstallStampPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopStateDir(env), "cli-install.json");
}

export function pathShimPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".local", "bin", "review");
}

/** Reads only the filesystem-backed agent state needed to choose a harness. */
export async function resolveInstalledReviewAgentStatus(
  input: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Pick<ReviewCliInstallStatus, "agents" | "stamp">> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;

  const [present, installed, stamp] = await Promise.all([
    detectPresentAgents(homeDir),
    detectInstalledTargets(homeDir),
    readCliInstallStamp(cliInstallStampPath(env)),
  ]);

  const installedSet = new Set(installed);

  return {
    agents: ALL_INSTALL_TARGETS.map((target) => ({
      target,
      present: present.has(target),
      installed: installedSet.has(target),
    })),
    stamp,
  };
}

export async function resolveCliInstallStatus(input: {
  packageRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReviewCliInstallStatus> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;

  const [agentStatus, fingerprint, trace] = await Promise.all([
    resolveInstalledReviewAgentStatus({ homeDir, env }),
    installFingerprint(input.packageRoot),
    traceMachineStatus({ homeDir, env }),
  ]);

  const { agents, stamp } = agentStatus;

  const managedTargets =
    stamp?.consent === "granted"
      ? (stamp.targets ??
        agents.filter((agent) => agent.installed).map((agent) => agent.target))
      : [];

  const skills = await resolveInstalledSkills({
    packageRoot: input.packageRoot,
    homeDir,
    targets: managedTargets,
    traceEnabled: trace.enabled,
  });

  const mcp = await Promise.all(
    REVIEW_MCP_TARGETS.map(async (target) => {
      const result = await reviewMcpStatus(
        reviewMcpRegistration(target, homeDir, env),
        stamp?.mcpRegistrations?.find((item) => item.target === target),
      );

      if (result.state === "ready" && !(await isFile(reviewMcpLauncher(env))))
        return { ...result, state: "missing" as const };

      return result;
    }),
  );

  const shimPath = pathShimPath(homeDir);
  const cliPath = path.join(input.packageRoot, "dist", "cli.js");
  const fffBinary = fffBinaryPath(homeDir);
  const fffCorpus = fffCorpusRoot(homeDir);

  const fffRegistrations = await Promise.all(
    FFF_TARGETS.map(async (target) => {
      const current = await readFffRegistration(target, homeDir, env);

      const managedRecord = stamp?.fffRegistrations?.find(
        (registration) => registration.target === target,
      );

      return {
        target,
        present: current.present,
        managed: Boolean(
          current.present &&
          managedRecord &&
          fffRegistrationMatches(current.output, managedRecord),
        ),
      };
    }),
  );

  const status: ReviewCliInstallStatus = {
    agents,
    fingerprint,
    stamp,
    stale:
      stamp?.consent === "granted" &&
      (stamp.fingerprint !== fingerprint ||
        skills.some((skill) => skill.stale) ||
        ((await isFile(cliPath)) &&
          mcp.some(
            (item) =>
              managedTargets.includes(item.target) && item.state === "missing",
          ))),
    skills,
    mcp,
    shim: {
      path: shimPath,
      installed: await isOwnedShim(shimPath),
      profileConfigured: await isShellProfileConfigured(homeDir),
      onPath: pathContainsDirectory(env.PATH, path.dirname(shimPath)),
    },
    fff: {
      serverName: FFF_SERVER_NAME,
      corpusRoot: fffCorpus,
      binary: { path: fffBinary, installed: await isFile(fffBinary) },
      registrations: fffRegistrations,
    },
    trace,
    cli: (await isFile(cliPath))
      ? {
          path: cliPath,
          version: readReviewPackageVersion(pathToFileURL(cliPath).href),
        }
      : null,
  };

  const error = installErrors.get(homeDir);

  if (error) status.error = error;

  return status;
}

interface ApplyCliInstallInput {
  packageRoot: string;
  targets: InstallTarget[];
  shim?: boolean;
  fff?: boolean;
  autoUpdate?: boolean;
  trace?: true | TraceCredentialsInput;
  cliPath?: string;
  cliRuntimePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function applyCliInstall(
  input: ApplyCliInstallInput,
): Promise<{ code: number; output: string; shimPath?: string }> {
  const homeDir = input.homeDir ?? os.homedir();

  try {
    const result = await withDesktopInstallLock(input.env, async () => {
      if (input.autoUpdate) {
        // Re-read consent under the mutation lock: a stale UI snapshot must
        // never reinstall a target the user has since removed or declined.
        const status = await resolveCliInstallStatus(input);
        const stamp = status.stamp;

        if (stamp?.consent !== "granted" || !status.stale)
          return { code: 0, output: "" };

        const targets =
          stamp.targets ??
          status.agents
            .filter((agent) => agent.installed)
            .map((agent) => agent.target);

        if (targets.length === 0 && !stamp.shimPath)
          return { code: 0, output: "" };

        return applyCliInstallUnlocked({
          ...input,
          targets,
          shim: Boolean(stamp.shimPath),
          fff: false,
          trace: undefined,
        });
      }

      return applyCliInstallUnlocked(input);
    });

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
      "Another Review setup operation is running. Retry shortly.",
    );

  return outcome.result;
}

async function applyCliInstallUnlocked(
  input: ApplyCliInstallInput,
): Promise<{ code: number; output: string; shimPath?: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const wantShim = input.shim ?? input.targets.length > 0;
  const chunks: string[] = [];
  const sink = collectingWritable(chunks);
  const fffTargets = input.fff ? input.targets.filter(isFffTarget) : [];

  const fffPresentBefore = new Map(
    await Promise.all(
      fffTargets.map(
        async (target) =>
          [
            target,
            (await readFffRegistration(target, homeDir, env)).present,
          ] as const,
      ),
    ),
  );

  if (input.targets.length > 0 || input.trace !== undefined) {
    const installInput: Parameters<typeof runInstall>[0] = {
      targets: input.targets,
      homeDir,
      packageRoot: input.packageRoot,
      env,
      fff: input.fff,
      skipCurrentSkills: input.autoUpdate,
      reviewCommand:
        wantShim || (await isFile(pathShimPath(homeDir)))
          ? pathShimPath(homeDir)
          : "review",
      stdout: sink,
      stderr: sink,
    };

    if (input.trace !== undefined) {
      installInput.trace = {
        credentials: input.trace === true ? undefined : input.trace,
      };
    }

    const code = await runInstall(installInput);

    if (code !== 0) return { code, output: chunks.join("") };
  }

  let shimPath: string | undefined;

  if (wantShim) {
    if (!input.cliPath) {
      chunks.push(
        input.shim === true
          ? "This server has no built CLI to install the command from.\n"
          : "Review did not install the review command because this server has no built CLI. The skills were installed.\n",
      );

      if (input.shim === true) {
        return { code: 1, output: chunks.join("") };
      }
    } else {
      const installed = await installReviewCommand({
        cliPath: input.cliPath,
        cliRuntimePath: input.cliRuntimePath,
        homeDir,
        env,
      });

      shimPath = installed.shimPath;
      chunks.push(installed.output);
    }
  }

  const createdFffRegistrations: ReviewFffManagedRegistration[] = [];

  for (const target of fffTargets) {
    if (fffPresentBefore.get(target)) continue;
    const current = await readFffRegistration(target, homeDir, env);

    if (current.present) {
      createdFffRegistrations.push(
        fffRegistration(target, fffBinaryPath(homeDir), fffCorpusRoot(homeDir)),
      );
    }
  }

  // The stamp is cumulative app-managed state: installing skills for one
  // agent must not drop other stamped agents or the command from re-sync.
  const previous = await readCliInstallStamp(cliInstallStampPath(env));

  const previousTargets =
    previous?.consent === "granted" ? (previous.targets ?? []) : [];

  const previousShimPath =
    previous?.consent === "granted" ? previous.shimPath : undefined;

  const previousFffRegistrations =
    previous?.consent === "granted" ? (previous.fffRegistrations ?? []) : [];

  const createdFffTargets = new Set(
    createdFffRegistrations.map((registration) => registration.target),
  );

  const fffRegistrations = [
    ...previousFffRegistrations.filter(
      (registration) => !createdFffTargets.has(registration.target),
    ),
    ...createdFffRegistrations,
  ];

  const stampShimPath = shimPath ?? previousShimPath;

  const traceManaged =
    input.trace !== undefined ||
    (previous?.consent === "granted" && previous.traceManaged === true);

  const stamp: ReviewCliInstallStamp = {
    consent: "granted",
    fingerprint: await installFingerprint(input.packageRoot),
    targets: [...new Set([...previousTargets, ...input.targets])],
    updatedAt: new Date().toISOString(),
  };

  if (stampShimPath) stamp.shimPath = stampShimPath;

  if (fffRegistrations.length > 0) stamp.fffRegistrations = fffRegistrations;

  if (traceManaged) stamp.traceManaged = true;
  stamp.mcpRegistrations = previous?.mcpRegistrations ?? [];
  // Save ownership as each target succeeds, so a later failure remains repairable.
  await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);

  if (
    input.cliPath &&
    input.targets.some((target) =>
      REVIEW_MCP_TARGETS.some((item) => item === target),
    )
  ) {
    await writePathShim(
      reviewMcpLauncher(env),
      input.cliPath,
      input.cliRuntimePath,
    );

    for (const target of REVIEW_MCP_TARGETS.filter((target) =>
      input.targets.includes(target),
    )) {
      const registration = reviewMcpRegistration(target, homeDir, env);

      const managed = stamp.mcpRegistrations.find(
        (item) => item.target === target,
      );

      const installed = await writeReviewMcpRegistration(registration, managed);

      if (!installed) {
        chunks.push(
          `The ${target} Review MCP entry was customized; left unchanged.\n`,
        );
        continue;
      }

      stamp.mcpRegistrations = [
        ...stamp.mcpRegistrations.filter((item) => item.target !== target),
        registration,
      ];
      await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);
      chunks.push(
        `[ok] Review MCP -> ${target}. Restart the agent or reconnect its MCP server to load the tools.\n`,
      );
    }
  }

  const result: Awaited<ReturnType<typeof applyCliInstall>> = {
    code: 0,
    output: chunks.join(""),
  };

  if (shimPath) result.shimPath = shimPath;

  return result;
}

export async function declineCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, () =>
    writePrivateJsonAtomic(cliInstallStampPath(env), {
      consent: "declined",
      updatedAt: new Date().toISOString(),
    } satisfies ReviewCliInstallStamp),
  );
}

export async function skipCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, async () => {
    const stampPath = cliInstallStampPath(env);

    if (await readCliInstallStamp(stampPath)) return;
    await writePrivateJsonAtomic(stampPath, {
      consent: "skipped",
      updatedAt: new Date().toISOString(),
    } satisfies ReviewCliInstallStamp);
  });
}

/** Removes the stamp entirely, so the next app launch prompts again. */
export async function resetCliInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withDesktopInstallLock(env, () =>
    rm(cliInstallStampPath(env), { force: true }),
  );
}

interface RemoveCliInstallInput {
  targets: InstallTarget[];
  shim?: boolean;
  fff?: boolean;
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
  const previous = await readCliInstallStamp(cliInstallStampPath(env));
  let keepMcpLauncher = false;

  for (const registration of previous?.mcpRegistrations ?? []) {
    if (!input.targets.includes(registration.target)) continue;

    const removed = await writeReviewMcpRegistration(
      registration,
      registration,
      true,
    );

    if (!removed) keepMcpLauncher = true;
    chunks.push(
      removed
        ? `[ok] removed ${registration.target} Review MCP\n`
        : `The ${registration.target} Review MCP entry changed after installation; left in place.\n`,
    );
  }

  for (const target of input.targets) {
    await removeInstalledSkills(target, homeDir);

    if (target !== "cursor") {
      await removeAgentTraceHook(target, homeDir);
    }

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

    for (const profilePath of await removeShellProfilePath(homeDir)) {
      chunks.push(`[ok] removed Review PATH entry from ${profilePath}\n`);
    }
  }

  if (input.trace) {
    // Repositories whose Git hooks call dev-traces belong to that install
    // and keep working after this app is gone.
    const { kept } = await disableAllTraceRepositories(
      traceScope({ homeDir, env }),
      { owner: "review" },
    );

    for (const root of kept) {
      chunks.push(`[skip] left the dev-traces Git hooks in ${root}\n`);
    }

    await disableTraceMachine({ homeDir, env });

    // Disabling capture also retires the per-agent pieces that exist only
    // for it, regardless of which targets this request named.
    for (const target of await detectInstalledTargets(homeDir)) {
      await removeTraceSkills(target, homeDir);

      if (target !== "cursor") {
        await removeAgentTraceHook(target, homeDir);
      }
    }

    chunks.push("[ok] disabled Review trace capture\n");
  }

  const removedFffTargets = new Set<ReviewFffInstallTarget>();
  const fffRemovalTargets = input.fff ? input.targets.filter(isFffTarget) : [];

  if (fffRemovalTargets.length > 0 && previous?.consent === "granted") {
    for (const target of fffRemovalTargets) {
      const managed = previous.fffRegistrations?.find(
        (registration) => registration.target === target,
      );

      if (!managed) {
        chunks.push(
          `The ${target} ${FFF_SERVER_NAME} registration is not managed by Review Desktop; left in place.\n`,
        );
        continue;
      }

      const current = await readFffRegistration(target, homeDir, env);

      if (
        !current.present ||
        !fffRegistrationMatches(current.output, managed)
      ) {
        chunks.push(
          `The ${target} ${FFF_SERVER_NAME} registration changed after installation; left in place.\n`,
        );
        removedFffTargets.add(target);
        continue;
      }

      const result = await removeFffRegistration(target, homeDir, env);

      if (!result.ok) {
        chunks.push(result.output);

        return { output: chunks.join("") };
      }

      chunks.push(`[ok] removed ${target} FFF integration\n`);
      removedFffTargets.add(target);
    }
  }

  if (previous?.consent === "granted") {
    const removed = new Set(input.targets);

    const targets = (previous.targets ?? []).filter(
      (target) => !removed.has(target),
    );

    const shimPath = input.shim ? undefined : previous.shimPath;

    const fffRegistrations = (previous.fffRegistrations ?? []).filter(
      (registration) => !removedFffTargets.has(registration.target),
    );

    const stamp: ReviewCliInstallStamp = {
      consent: "granted",
      targets,
      updatedAt: new Date().toISOString(),
    };

    if (previous.fingerprint) stamp.fingerprint = previous.fingerprint;

    if (shimPath) stamp.shimPath = shimPath;

    if (fffRegistrations.length > 0) stamp.fffRegistrations = fffRegistrations;
    stamp.mcpRegistrations = previous.mcpRegistrations?.filter(
      (item) => !removed.has(item.target),
    );

    if (
      !keepMcpLauncher &&
      !stamp.mcpRegistrations?.length &&
      previous.mcpRegistrations?.length &&
      (await isOwnedShim(reviewMcpLauncher(env)))
    ) {
      await rm(reviewMcpLauncher(env), { force: true });
    }

    if (!input.trace && previous.traceManaged) stamp.traceManaged = true;
    await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);
  }

  return { output: chunks.join("") };
}

/**
 * Fingerprint of the CLI and agent integrations. Skills are compared
 * independently through their release versions. Content-based so it works
 * identically in a dev checkout and a packaged review-runtime, with no
 * build-time stamping.
 */
export async function installFingerprint(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readTextIfExists(path.join(packageRoot, "package.json")));
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  hash.update("dist/cli.js\0");
  hash.update(await readTextIfExists(cliPath));

  for (const file of await listFilesRecursive(
    path.join(packageRoot, "plugins"),
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
# Managed by Review Desktop ("Review: Install CLI in PATH"). Do not edit.
FALLBACK_CLI=${shSingleQuote(cliPath)}
FALLBACK_RUNTIME=${shSingleQuote(runtimePath ?? "")}
DISCOVERY="\${DEV_REVIEW_HOME:-$HOME/.dev}/review-desktop/server.json"

cli=""
runtime=""
delegated=""
if [ -z "\${DEV_FAST_REVIEW_CLI_NO_DELEGATE:-}" ] && [ -f "$DISCOVERY" ]; then
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
  echo "Review CLI not found at $cli. Start Review Desktop, or run npx @dev.fast/review instead." >&2
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
}): Promise<{ shimPath: string; output: string }> {
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const shimPath = pathShimPath(homeDir);
  const shadowingCommand = await resolvePathCommand("review", shimPath, env);

  await writePathShim(shimPath, input.cliPath, input.cliRuntimePath);
  const profileOutput = await ensureShellProfilePath({ homeDir, env });

  const shadowingOutput = shadowingCommand
    ? `Warning: ${shadowingCommand} currently shadows ${shimPath}. See ${SHADOWING_HELP_URL}\n`
    : "";

  return {
    shimPath,
    output: `[ok] review command -> ${shimPath}\n${profileOutput}${shadowingOutput}`,
  };
}

export async function ensureShellProfilePath(input: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const shimDirectory = path.dirname(pathShimPath(input.homeDir));

  if (pathContainsDirectory(input.env.PATH, shimDirectory)) return "";

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
    return "Review did not update PATH for this shell. Add ~/.local/bin to PATH. Fish users can run: fish_add_path ~/.local/bin\n";
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

async function isOwnedShim(shimPath: string): Promise<boolean> {
  return (await readTextIfExists(shimPath)).includes(SHIM_MARKER);
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

async function isExecutableFile(target: string): Promise<boolean> {
  if (!(await isFile(target))) return false;

  try {
    await access(target, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}
