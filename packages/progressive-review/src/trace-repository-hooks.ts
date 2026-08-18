import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface RepositoryHookState {
  version: 1;
  root: string;
  managedHooksPath: string;
  previousHooksPath: string;
  previousHookDirectory: string;
  previousWasConfigured: boolean;
}

export interface TraceRepositoryStatus {
  repository: boolean;
  enabled: boolean;
  root?: string;
  managedHooksPath?: string;
  previousHooksPath?: string;
  message: string;
}

export async function enableTraceRepository(input: {
  cwd: string;
  homeDir?: string;
  reviewCommand?: string;
}): Promise<TraceRepositoryStatus> {
  const resolved = await resolveRepository(input.cwd);
  if (!resolved) {
    return {
      repository: false,
      enabled: false,
      message: "Not inside a Git repository.",
    };
  }
  const statePath = path.join(
    resolved.commonDir,
    "dev-fast",
    "trace-hooks",
    "state.json",
  );
  const hooksPath = path.join(
    resolved.commonDir,
    "dev-fast",
    "trace-hooks",
    "hooks",
  );
  const current = await configuredHooksPath(resolved.root);
  const oldState = await readState(statePath);
  const alreadyManaged =
    path.resolve(resolved.root, current.value || ".") ===
    path.resolve(hooksPath);
  const previousWasConfigured = alreadyManaged
    ? (oldState?.previousWasConfigured ?? false)
    : current.configured;
  const previousHooksPath = alreadyManaged
    ? (oldState?.previousHooksPath ?? path.join(resolved.commonDir, "hooks"))
    : current.configured
      ? current.value
      : path.join(resolved.commonDir, "hooks");
  const previousHookDirectory = alreadyManaged
    ? (oldState?.previousHookDirectory ??
      resolveHooksPath(resolved.root, previousHooksPath))
    : previousHooksPath;
  const state: RepositoryHookState = {
    version: 1,
    root: resolved.root,
    managedHooksPath: hooksPath,
    previousHooksPath,
    previousHookDirectory,
    previousWasConfigured,
  };

  const homeDir = input.homeDir ?? traceHomeDir();
  const installedCommand = path.join(homeDir, ".local", "bin", "review");
  const reviewCommand =
    input.reviewCommand ??
    process.env.REVIEW_TRACE_COMMAND ??
    (existsSync(installedCommand) ? installedCommand : "review");
  await mkdir(hooksPath, { recursive: true });
  await writeHook(
    path.join(hooksPath, "prepare-commit-msg"),
    prepareCommitMessageHook(previousHookDirectory, reviewCommand),
  );
  await writeHook(
    path.join(hooksPath, "pre-push"),
    prePushHook(previousHookDirectory, reviewCommand),
  );
  await writePrivateJson(statePath, state);
  await runGit(resolved.root, [
    "config",
    "--local",
    "core.hooksPath",
    hooksPath,
  ]);
  await registerRepository(homeDir, resolved.root);
  return {
    repository: true,
    enabled: true,
    root: resolved.root,
    managedHooksPath: hooksPath,
    previousHooksPath,
    message: "Review trace hooks are enabled for this repository.",
  };
}

export async function repairTraceRepository(input: {
  cwd: string;
  homeDir?: string;
  reviewCommand?: string;
}): Promise<TraceRepositoryStatus> {
  return enableTraceRepository(input);
}

export async function disableTraceRepository(input: {
  cwd: string;
  homeDir?: string;
}): Promise<TraceRepositoryStatus> {
  const resolved = await resolveRepository(input.cwd);
  if (!resolved) {
    return {
      repository: false,
      enabled: false,
      message: "Not inside a Git repository.",
    };
  }
  const stateDir = path.join(resolved.commonDir, "dev-fast", "trace-hooks");
  const state = await readState(path.join(stateDir, "state.json"));
  if (!state) {
    return {
      repository: true,
      enabled: false,
      root: resolved.root,
      message: "Review trace hooks are not enabled for this repository.",
    };
  }
  const current = await configuredHooksPath(resolved.root);
  if (
    path.resolve(resolved.root, current.value || ".") ===
    path.resolve(state.managedHooksPath)
  ) {
    if (state.previousWasConfigured) {
      await runGit(resolved.root, [
        "config",
        "--local",
        "core.hooksPath",
        state.previousHooksPath,
      ]);
    } else {
      await runGit(
        resolved.root,
        ["config", "--local", "--unset", "core.hooksPath"],
        true,
      );
    }
  }
  await rm(stateDir, { recursive: true, force: true });
  await unregisterRepository(input.homeDir ?? traceHomeDir(), resolved.root);
  return {
    repository: true,
    enabled: false,
    root: resolved.root,
    message: "Review trace hooks are disabled for this repository.",
  };
}

export async function traceRepositoryStatus(
  cwd: string,
): Promise<TraceRepositoryStatus> {
  const resolved = await resolveRepository(cwd);
  if (!resolved)
    return {
      repository: false,
      enabled: false,
      message: "Not inside a Git repository.",
    };
  const state = await readState(
    path.join(resolved.commonDir, "dev-fast", "trace-hooks", "state.json"),
  );
  const current = await configuredHooksPath(resolved.root);
  const enabled = Boolean(
    state &&
    path.resolve(resolved.root, current.value || ".") ===
      path.resolve(state.managedHooksPath),
  );
  return {
    repository: true,
    enabled,
    root: resolved.root,
    ...(state
      ? {
          managedHooksPath: state.managedHooksPath,
          previousHooksPath: state.previousHooksPath,
        }
      : {}),
    message: enabled
      ? "Review trace hooks are enabled for this repository."
      : "Review trace hooks are not enabled for this repository.",
  };
}

export async function disableAllTraceRepositories(
  homeDir = os.homedir(),
): Promise<void> {
  const registry = await readRegistry(homeDir);
  for (const root of registry) {
    await disableTraceRepository({ cwd: root, homeDir }).catch(() => undefined);
  }
}

function traceHomeDir(): string {
  return process.env.TRACE_HOME_DIR ?? os.homedir();
}

async function resolveRepository(
  cwd: string,
): Promise<{ root: string; commonDir: string } | null> {
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], true);
  const commonResult = await runGit(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    true,
  );
  if (!rootResult.ok || !commonResult.ok) return null;
  return {
    root: rootResult.stdout.trim(),
    commonDir: commonResult.stdout.trim(),
  };
}

async function configuredHooksPath(
  root: string,
): Promise<{ configured: boolean; value: string }> {
  const result = await runGit(
    root,
    ["config", "--local", "--get", "core.hooksPath"],
    true,
  );
  return {
    configured: result.ok && Boolean(result.stdout.trim()),
    value: result.stdout.trim(),
  };
}

function resolveHooksPath(root: string, hooksPath: string): string {
  return path.isAbsolute(hooksPath) ? hooksPath : path.resolve(root, hooksPath);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function previousHookSetup(pathValue: string, name: string): string {
  if (path.isAbsolute(pathValue)) {
    return `previous=${shellQuote(path.join(pathValue, name))}`;
  }
  return [
    'root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    `previous="$root"/${shellQuote(path.join(pathValue, name))}`,
  ].join("\n");
}

function prepareCommitMessageHook(
  previousPath: string,
  reviewCommand: string,
): string {
  const previous = previousHookSetup(previousPath, "prepare-commit-msg");
  const review = shellQuote(reviewCommand);
  return `#!/bin/sh\n${previous}\nif [ -x "$previous" ]; then\n  "$previous" "$@" || exit $?\nfi\n${review} trace git-hook prepare-commit-msg "$@" || true\nexit 0\n`;
}

function prePushHook(previousPath: string, reviewCommand: string): string {
  const previous = previousHookSetup(previousPath, "pre-push");
  const review = shellQuote(reviewCommand);
  return `#!/bin/sh\n${previous}\ntmp="$(mktemp "\${TMPDIR:-/tmp}/review-pre-push.XXXXXX")" || exit 0\ntrap 'rm -f "$tmp"' EXIT HUP INT TERM\ncat > "$tmp"\nif [ -x "$previous" ]; then\n  "$previous" "$@" < "$tmp" || exit $?\nfi\n${review} trace git-hook pre-push "$@" < "$tmp" || true\nexit 0\n`;
}

async function writeHook(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

async function readState(
  filePath: string,
): Promise<RepositoryHookState | null> {
  try {
    const value = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as RepositoryHookState;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function registryPath(homeDir: string): string {
  return path.join(homeDir, ".config", "dev-trace", "repositories.json");
}

async function readRegistry(homeDir: string): Promise<string[]> {
  try {
    const value = JSON.parse(
      await readFile(registryPath(homeDir), "utf8"),
    ) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function registerRepository(
  homeDir: string,
  root: string,
): Promise<void> {
  const current = await readRegistry(homeDir);
  await writePrivateJson(registryPath(homeDir), [
    ...new Set([...current, root]),
  ]);
}

async function unregisterRepository(
  homeDir: string,
  root: string,
): Promise<void> {
  await writePrivateJson(
    registryPath(homeDir),
    (await readRegistry(homeDir)).filter((entry) => entry !== root),
  );
}

async function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { ok: true, stdout, stderr };
  } catch (cause) {
    if (!allowFailure) throw cause;
    const error = cause as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(cause),
    };
  }
}
