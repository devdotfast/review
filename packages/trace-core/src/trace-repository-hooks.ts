import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { jsonArray, jsonString, parseJsonText } from "@dev.fast/json";
import { gitAt } from "@dev.fast/local-vcs";
import { z } from "zod";

import { writeFileAtomicAsync } from "./atomic-write";
import {
  type TraceCommand,
  type TraceScope,
  keepTraceExecutable,
  renderTraceCommand,
  resolveTraceCommand,
  shellQuote,
  traceCommandExecutable,
  traceHomeDir,
} from "./trace-command";

const repositoryHookStateSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  managedHooksPath: z.string(),
  previousHooksPath: z.string(),
  previousHookDirectory: z.string(),
  previousWasConfigured: z.boolean(),
  command: z.string().optional(),
});

type RepositoryHookState = z.infer<typeof repositoryHookStateSchema>;

export interface TraceRepositoryStatus {
  repository: boolean;
  enabled: boolean;
  root?: string;
  managedHooksPath?: string;
  previousHooksPath?: string;
  /** The rendered hook command, when hooks are installed. */
  command?: string;
  message: string;
}

export async function enableTraceRepository(input: {
  cwd: string;
  scope: TraceScope;
  reviewCommand?: string | TraceCommand;
  /** Explicit command migration; ordinary activation preserves a working installation. */
  replaceCommand?: boolean;
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

  const homeDir = input.scope.homeDir;

  let reviewCommand = renderTraceCommand(
    resolveTraceCommand({
      explicit: input.reviewCommand,
      env: input.scope.env,
      homeDir,
    }),
  );

  if (
    alreadyManaged &&
    !input.replaceCommand &&
    oldState?.command &&
    keepTraceExecutable(
      traceCommandExecutable(oldState.command),
      traceCommandExecutable(reviewCommand) ?? "",
    )
  )
    reviewCommand = oldState.command;

  const state: RepositoryHookState = {
    version: 1,
    root: resolved.root,
    managedHooksPath: hooksPath,
    previousHooksPath,
    previousHookDirectory,
    previousWasConfigured,
    command: reviewCommand,
  };

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
  await gitAt(resolved.root, [
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
    command: reviewCommand,
    message: "Review trace hooks are enabled for this repository.",
  };
}

export async function repairTraceRepository(input: {
  cwd: string;
  scope: TraceScope;
  reviewCommand?: string | TraceCommand;
}): Promise<TraceRepositoryStatus> {
  return enableTraceRepository(input);
}

export async function disableTraceRepository(input: {
  cwd: string;
  scope: TraceScope;
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
      await gitAt(resolved.root, [
        "config",
        "--local",
        "core.hooksPath",
        state.previousHooksPath,
      ]);
    } else {
      await gitAt(
        resolved.root,
        ["config", "--local", "--unset", "core.hooksPath"],
        { allowFailure: true },
      );
    }
  }

  await rm(stateDir, { recursive: true, force: true });
  await unregisterRepository(input.scope.homeDir, resolved.root);

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

  const status: TraceRepositoryStatus = {
    repository: true,
    enabled,
    root: resolved.root,
    message: enabled
      ? "Review trace hooks are enabled for this repository."
      : "Review trace hooks are not enabled for this repository.",
  };

  if (state) {
    status.managedHooksPath = state.managedHooksPath;
    status.previousHooksPath = state.previousHooksPath;

    if (state.command !== undefined) status.command = state.command;
  }

  return status;
}

/** Disables registered hooks, preserving other live executables when scoped. */
export async function disableAllTraceRepositories(
  scope: TraceScope,
  expectedCommand?: string,
): Promise<{ disabled: string[]; kept: string[] }> {
  const registry = await readRegistry(scope.homeDir);
  const disabled: string[] = [];
  const kept: string[] = [];

  for (const root of registry) {
    if (expectedCommand !== undefined) {
      const status = await traceRepositoryStatus(root).catch(() => null);

      if (
        keepTraceExecutable(
          traceCommandExecutable(status?.command),
          expectedCommand,
        )
      ) {
        kept.push(root);
        continue;
      }
    }

    const result = await disableTraceRepository({ cwd: root, scope }).catch(
      () => null,
    );

    if (result?.repository) disabled.push(root);
  }

  return { disabled, kept };
}

async function resolveRepository(
  cwd: string,
): Promise<{ root: string; commonDir: string } | null> {
  const rootResult = await gitAt(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });

  const commonResult = await gitAt(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true },
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
  const result = await gitAt(
    root,
    ["config", "--local", "--get", "core.hooksPath"],
    { allowFailure: true },
  );

  return {
    configured: result.ok && Boolean(result.stdout.trim()),
    value: result.stdout.trim(),
  };
}

function resolveHooksPath(root: string, hooksPath: string): string {
  return path.isAbsolute(hooksPath) ? hooksPath : path.resolve(root, hooksPath);
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
  const review = reviewCommand;

  return `#!/bin/sh\n${previous}\nif [ -x "$previous" ]; then\n  "$previous" "$@" || exit $?\nfi\n${review} trace git-hook prepare-commit-msg "$@" || true\nexit 0\n`;
}

function prePushHook(previousPath: string, reviewCommand: string): string {
  const previous = previousHookSetup(previousPath, "pre-push");
  const review = reviewCommand;

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
    const parsed = repositoryHookStateSchema.safeParse(
      parseJsonText(await readFile(filePath, "utf8")),
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writePrivateJson(
  filePath: string,
  value: RepositoryHookState | string[],
): Promise<void> {
  await writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function registryPath(homeDir: string): string {
  return path.join(homeDir, ".config", "dev-trace", "repositories.json");
}

/** Returns the registered repository roots; never scans repositories or changes hooks. */
export function listTraceRepositoryRoots(homeDir?: string): Promise<string[]> {
  return readRegistry(homeDir ?? traceHomeDir());
}

async function readRegistry(homeDir: string): Promise<string[]> {
  try {
    const value = parseJsonText(await readFile(registryPath(homeDir), "utf8"));

    return (jsonArray(value) ?? [])
      .map(jsonString)
      .filter((item) => item !== undefined);
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
