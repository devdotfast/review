import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  isJsonArray,
  isJsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/json";

import { shellQuote, traceCliName } from "./trace-command";

export type AgentTraceHookAgent = "claude" | "codex" | "opencode" | "pi";

/** Every harness whose trace hook this package writes, in report order. */
export const AGENT_TRACE_HOOK_AGENTS: readonly AgentTraceHookAgent[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
];

export interface AgentTraceHookInstallResult {
  agent: AgentTraceHookAgent;
  path: string;
  modified: boolean;
  /** The other CLI, when its live hook stayed in place instead of ours. */
  kept?: TraceHookOwner;
}

const PI_EXTENSION_MARKER = "Managed by Review Desktop trace setup";

const OPENCODE_TRACE_PLUGIN_MARKER = PI_EXTENSION_MARKER;

export type TraceHookOwner = "review" | "dev-traces";

function claudeSettingsPath(homeDir: string): string {
  return path.join(homeDir, ".claude", "settings.json");
}

function codexConfigPath(homeDir: string): string {
  return path.join(homeDir, ".codex", "config.toml");
}

function piExtensionPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "extensions", "review-trace.ts");
}

/** The configuration base OpenCode reads: `$XDG_CONFIG_HOME`, else `~/.config`. */
function configHome(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
}

function openCodeDirectory(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(configHome(homeDir, env), "opencode");
}

function openCodePluginPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    openCodeDirectory(homeDir, env),
    "plugins",
    "review-trace.ts",
  );
}

function executableOwner(file: string): TraceHookOwner | null {
  const base = path.basename(file);

  return base === "review" || base === "dev-traces" ? base : null;
}

/** The executable of a single lifecycle command, or undefined for a shell compound. */
function traceHookCommandFile(
  command: JsonValue | undefined,
): string | undefined {
  const text = jsonString(command);

  if (text === undefined) return undefined;

  const match =
    /^(.*) trace hook (SessionStart|UserPromptSubmit|SessionEnd)$/.exec(text);

  if (!match) return undefined;
  const prefix = match[1];

  if (/^[a-zA-Z0-9_./-]+$/.test(prefix)) return prefix;
  const decoded = prefix.slice(1, -1).replaceAll(`'"'"'`, "'");

  return shellQuote(decoded) === prefix ? decoded : undefined;
}

/** Identifies a single executable lifecycle command; never accepts shell compounds. */
export function traceHookCommandOwner(
  command: JsonValue | undefined,
): TraceHookOwner | null {
  const file = traceHookCommandFile(command);

  return file === undefined ? null : executableOwner(file);
}

/**
 * The executable a Git hook state file names. The state stores the rendered
 * command, so the executable is its first shell-quoted word.
 */
function traceGitHookCommandFile(command: string | undefined) {
  if (command === undefined) return undefined;

  const quoted = /^'((?:[^']|'"'"')*)'(?:\s|$)/.exec(command);
  const bare = /^([^\s']+)(?:\s|$)/.exec(command);

  return quoted
    ? quoted[1]!.replaceAll(`'"'"'`, "'")
    : bare
      ? bare[1]!
      : undefined;
}

/** The owner of a rendered Git hook command, when it is `review` or `dev-traces`. */
export function traceGitHookCommandOwner(
  command: string | undefined,
): TraceHookOwner | null {
  const file = traceGitHookCommandFile(command);

  return file === undefined ? null : executableOwner(file);
}

function extensionCommandFile(source: string): string | undefined {
  if (!source.trimStart().startsWith(`// ${PI_EXTENSION_MARKER}`))
    return undefined;
  const match = /spawn\(("(?:[^"\\]|\\.)*"), \["trace", "hook"/.exec(source);

  if (!match) return undefined;

  return jsonString(parseJsonText(match[1]));
}

function extensionOwner(source: string): TraceHookOwner | null {
  const file = extensionCommandFile(source);

  return file === undefined ? null : executableOwner(file);
}

/**
 * The owner of an installed hook that an install of `wanted` leaves in place:
 * the other CLI, while its command file still exists. Each CLI then keeps
 * the hooks it wrote first, and an uninstall of either removes only its own.
 * A bare command name is not checked on PATH, so it is always replaced; the
 * installs write absolute paths. A hook whose file is gone is replaced too.
 */
export function keptTraceHookOwner(
  existingFile: string | undefined,
  wanted: string,
): TraceHookOwner | null {
  if (existingFile === undefined) return null;
  const owner = executableOwner(existingFile);

  if (owner === null || owner === executableOwner(wanted)) return null;

  return path.isAbsolute(existingFile) && existsSync(existingFile)
    ? owner
    : null;
}

function piExtensionSource(reviewCommand: string): string {
  return `// ${PI_EXTENSION_MARKER}
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    runTraceHook("SessionStart", sessionId, ctx.cwd);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    runTraceHook("TurnStart", sessionId, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;
    runTraceHook("SessionEnd", sessionId, ctx.cwd);
  });
}

function runTraceHook(eventName: string, sessionId: string, cwd: string) {
  const payload = JSON.stringify({
    hook_event_name: eventName,
    session_id: sessionId,
  });

  const proc = spawn(${JSON.stringify(reviewCommand)}, ["trace", "hook", eventName], {
    cwd,
    stdio: ["pipe", "ignore", "ignore"],
  });

  // Missing binaries and closed pipes must never crash the harness.
  proc.on("error", () => {});
  proc.stdin.on("error", () => {});
  proc.stdin.end(payload);
}
`;
}

function openCodeTracePluginSource(reviewCommand: string): string {
  return `// ${OPENCODE_TRACE_PLUGIN_MARKER}
import { spawn } from "node:child_process";

interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

// OpenCode has no session-end event. A session goes idle after each turn,
// so every turn is one SessionStart/UserPromptSubmit .. SessionEnd cycle:
// the prompt registers the session for commit stamping and idle syncs the
// trace. Child sessions spawned by the task tool stay attached to their
// parent's turn and are never registered on their own.
export default async function reviewTracePlugin(input: { directory: string }) {
  const directories = new Map<string, string>();
  const childSessions = new Set<string>();

  return {
    event: async ({ event }: { event: OpenCodeEvent }) => {
      const properties = event.properties;
      if (event.type === "session.created") {
        const info = record(properties.info);
        const sessionId = text(info.id);
        if (!sessionId) return;
        if (typeof info.parentID === "string") {
          childSessions.add(sessionId);
          return;
        }
        const directory = text(info.directory) ?? input.directory;
        directories.set(sessionId, directory);
        runTraceHook("SessionStart", sessionId, directory);
        return;
      }
      if (event.type === "message.updated") {
        const info = record(properties.info);
        if (info.role !== "user") return;
        const sessionId = text(info.sessionID);
        if (!sessionId || childSessions.has(sessionId)) return;
        runTraceHook(
          "UserPromptSubmit",
          sessionId,
          directories.get(sessionId) ?? input.directory,
        );
        return;
      }
      if (event.type === "session.idle") {
        const sessionId = text(properties.sessionID);
        if (!sessionId || childSessions.has(sessionId)) return;
        runTraceHook(
          "SessionEnd",
          sessionId,
          directories.get(sessionId) ?? input.directory,
        );
      }
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function runTraceHook(eventName: string, sessionId: string, cwd: string) {
  const payload = JSON.stringify({
    hook_event_name: eventName,
    session_id: sessionId,
  });

  const proc = spawn(${JSON.stringify(reviewCommand)}, ["trace", "hook", eventName], {
    cwd,
    stdio: ["pipe", "ignore", "ignore"],
  });

  // Missing binaries and closed pipes must never crash the harness.
  proc.on("error", () => {});
  proc.stdin.on("error", () => {});
  proc.stdin.end(payload);
}
`;
}

/**
 * Installs the session lifecycle hook of every harness this package owns.
 *
 * `harnessHooks: false` installs none, so one caller can keep the option its
 * command registers. The result names each file that was written, in the
 * order the installers ran.
 */
export async function installHarnessHooks(input: {
  homeDir: string;
  /** The executable the hooks run; the CLI name when absent. */
  executable?: string;
  /** False skips every installer. */
  harnessHooks?: boolean;
  /** True writes every hook, even for a harness this machine lacks. */
  allHarnesses?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  installed: AgentTraceHookInstallResult[];
  skipped: AgentTraceHookAgent[];
  /** Harnesses whose live hook the other CLI owns; that hook stayed. */
  kept: AgentTraceHookAgent[];
}> {
  const installed: AgentTraceHookInstallResult[] = [];
  const skipped: AgentTraceHookAgent[] = [];
  const kept: AgentTraceHookAgent[] = [];

  if (input.harnessHooks === false) return { installed, skipped, kept };

  const env = input.env ?? process.env;

  for (const agent of AGENT_TRACE_HOOK_AGENTS) {
    const present = existsSync(
      agentTraceHomeDirectory(agent, input.homeDir, env),
    );

    if (input.allHarnesses !== true && !present) {
      skipped.push(agent);
      continue;
    }

    const result = await HARNESS_HOOK_INSTALLERS[agent](
      input.homeDir,
      input.executable,
      env,
    );

    installed.push(result);

    if (result.kept) kept.push(agent);
  }

  return { installed, skipped, kept };
}

/** One line that names the harness hooks the other CLI still owns. */
export function keptHarnessesLine(
  kept: readonly AgentTraceHookAgent[],
): string {
  return `Kept the ${kept.join(", ")} hook${kept.length === 1 ? "" : "s"} the other CLI installed: its command file still exists, and it captures to the same store.\n`;
}

/** The installer of one harness hook, keyed by the harness. */
const HARNESS_HOOK_INSTALLERS: Record<
  AgentTraceHookAgent,
  (
    homeDir: string,
    command?: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<AgentTraceHookInstallResult>
> = {
  claude: installClaudeTraceHook,
  codex: installCodexTraceHook,
  opencode: installOpenCodeTraceExtension,
  pi: installPiTraceExtension,
};

/** One line that names the harnesses an install left alone. */
export function skippedHarnessesLine(
  skipped: readonly AgentTraceHookAgent[],
): string {
  return `Skipped the ${skipped.join(", ")} hook${skipped.length === 1 ? "" : "s"}: this machine has no such harness. Use --all-harnesses to write them anyway.\n`;
}

/**
 * Idempotently configures Claude Code session lifecycle hooks in ~/.claude/settings.json.
 */
export async function installClaudeTraceHook(
  homeDir = os.homedir(),
  reviewCommand = traceCliName(),
): Promise<AgentTraceHookInstallResult> {
  const settingsDir = path.join(homeDir, ".claude");
  const settingsPath = claudeSettingsPath(homeDir);

  let parsed: JsonObject = {};

  if (existsSync(settingsPath)) {
    try {
      const content = parseJsonText(await readFile(settingsPath, "utf8"));

      if (isJsonObject(content)) parsed = content;
    } catch {
      parsed = {};
    }
  }

  const hooks: JsonObject = isJsonObject(parsed.hooks) ? parsed.hooks : {};
  let modified = false;
  let kept: TraceHookOwner | null = null;

  const hookCommand = (
    eventName: "SessionStart" | "UserPromptSubmit" | "SessionEnd",
  ) => ({
    type: "command",
    command: `${shellCommand(reviewCommand)} trace hook ${eventName}`,
  });

  for (const eventName of [
    "SessionStart",
    "UserPromptSubmit",
    "SessionEnd",
  ] as const) {
    const existing = hooks[eventName];
    const group: JsonValue[] = isJsonArray(existing) ? existing : [];
    const wanted = hookCommand(eventName);
    let found = false;

    for (const entry of group) {
      if (!isJsonObject(entry) || !isJsonArray(entry.hooks)) continue;

      for (const hook of entry.hooks) {
        if (!isJsonObject(hook)) continue;
        const file = traceHookCommandFile(hook.command);

        if (file === undefined || executableOwner(file) === null) continue;
        found = true;
        const keptOwner = keptTraceHookOwner(file, reviewCommand);

        if (keptOwner) {
          kept = keptOwner;
          continue;
        }

        if (hook.command !== wanted.command) {
          hook.command = wanted.command;
          modified = true;
        }
      }
    }

    if (!found) {
      group.push({ hooks: [wanted] });
      modified = true;
    }

    hooks[eventName] = group;
  }

  if (modified || !existsSync(settingsPath)) {
    parsed.hooks = hooks;
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
  }

  const result: AgentTraceHookInstallResult = {
    agent: "claude",
    path: settingsPath,
    modified,
  };

  if (kept) result.kept = kept;

  return result;
}

/**
 * Idempotently configures Codex session lifecycle hooks in ~/.codex/config.toml.
 */
export async function installCodexTraceHook(
  homeDir = os.homedir(),
  reviewCommand = traceCliName(),
): Promise<AgentTraceHookInstallResult> {
  const codexDir = path.join(homeDir, ".codex");
  const configPath = codexConfigPath(homeDir);

  let existing = "";

  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf8");
  }

  const hookEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "SessionEnd",
  ] as const;

  const found = new Set<string>();
  let kept: TraceHookOwner | null = null;

  let next = transformCodexHooks(existing, (block, command, event) => {
    const file = traceHookCommandFile(command);

    if (file === undefined || executableOwner(file) === null) return block;
    found.add(event);
    const keptOwner = keptTraceHookOwner(file, reviewCommand);

    if (keptOwner) {
      kept = keptOwner;

      return block;
    }

    return block.replace(
      /^command = .*$/m,
      () =>
        `command = ${JSON.stringify(`${shellCommand(reviewCommand)} trace hook ${event}`)}`,
    );
  });

  const missing = hookEvents.filter((event) => !found.has(event));

  if (missing.length > 0) {
    next = existing
      ? `${next.trimEnd()}\n\n${missing.map((event) => codexTraceHookToml(event, reviewCommand)).join("\n\n")}\n`
      : codexHookBlock(reviewCommand).trimStart();
  }

  const result: AgentTraceHookInstallResult = {
    agent: "codex",
    path: configPath,
    modified: next !== existing,
  };

  if (kept) result.kept = kept;

  if (!result.modified) return result;
  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, next, "utf8");

  return result;
}

/**
 * Idempotently writes the Pi session lifecycle extension into ~/.pi/agent/extensions/review-trace.ts.
 */
export async function installPiTraceExtension(
  homeDir = os.homedir(),
  reviewCommand = traceCliName(),
): Promise<AgentTraceHookInstallResult> {
  const extensionsDir = path.join(homeDir, ".pi", "agent", "extensions");
  const extensionPath = piExtensionPath(homeDir);

  let existing = "";

  if (existsSync(extensionPath)) {
    existing = await readFile(extensionPath, "utf8");
  }

  const kept = keptTraceHookOwner(
    extensionCommandFile(existing),
    reviewCommand,
  );

  if (kept) return { agent: "pi", path: extensionPath, modified: false, kept };
  const source = piExtensionSource(reviewCommand);

  if (existing.trim() === source.trim()) {
    return { agent: "pi", path: extensionPath, modified: false };
  }

  await mkdir(extensionsDir, { recursive: true });
  await writeFile(extensionPath, source, "utf8");

  return { agent: "pi", path: extensionPath, modified: true };
}

/**
 * Idempotently writes the OpenCode trace plugin into ~/.config/opencode/plugins/review-trace.ts.
 */
export async function installOpenCodeTraceExtension(
  homeDir = os.homedir(),
  reviewCommand = traceCliName(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentTraceHookInstallResult> {
  const pluginPath = openCodePluginPath(homeDir, env);
  const pluginsDir = path.dirname(pluginPath);

  let existing = "";

  if (existsSync(pluginPath)) {
    existing = await readFile(pluginPath, "utf8");
  }

  const kept = keptTraceHookOwner(
    extensionCommandFile(existing),
    reviewCommand,
  );

  if (kept)
    return { agent: "opencode", path: pluginPath, modified: false, kept };
  const source = openCodeTracePluginSource(reviewCommand);

  if (existing.trim() === source.trim()) {
    return { agent: "opencode", path: pluginPath, modified: false };
  }

  await mkdir(pluginsDir, { recursive: true });
  await writeFile(pluginPath, source, "utf8");

  return { agent: "opencode", path: pluginPath, modified: true };
}

/** Removes only the selected CLI owner’s lifecycle hooks; preserves foreign hooks. */
export async function removeAgentTraceHook(
  agent: AgentTraceHookAgent,
  homeDir = os.homedir(),
  owner: TraceHookOwner = "review",
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (agent === "claude") {
    const settingsPath = claudeSettingsPath(homeDir);

    if (!existsSync(settingsPath)) return false;
    let parsed: JsonValue;

    try {
      parsed = parseJsonText(await readFile(settingsPath, "utf8"));
    } catch {
      return false;
    }

    if (!isJsonObject(parsed)) return false;
    const hooks = parsed.hooks;

    if (!isJsonObject(hooks)) return false;
    let changed = false;

    for (const eventName of [
      "SessionStart",
      "UserPromptSubmit",
      "SessionEnd",
    ] as const) {
      const existing = hooks[eventName];
      const groups: JsonValue[] = isJsonArray(existing) ? existing : [];

      const keptGroups = groups.flatMap((group): JsonValue[] => {
        if (!isJsonObject(group)) return [group];

        if (!isJsonArray(group.hooks)) return [group];

        const keptHooks = group.hooks.filter((hook) => {
          const command = isJsonObject(hook) ? hook.command : undefined;
          const owned = traceHookCommandOwner(command) === owner;

          if (owned) changed = true;

          return !owned;
        });

        return keptHooks.length > 0 ? [{ ...group, hooks: keptHooks }] : [];
      });

      if (keptGroups.length > 0) hooks[eventName] = keptGroups;
      else delete hooks[eventName];
    }

    if (!changed) return false;
    parsed.hooks = hooks;
    await writeFile(
      settingsPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );

    return true;
  }

  if (agent === "codex") {
    const configPath = codexConfigPath(homeDir);

    if (!existsSync(configPath)) return false;
    const existing = await readFile(configPath, "utf8");

    const removed = transformCodexHooks(existing, (block, command) =>
      traceHookCommandOwner(command) === owner ? "" : block,
    ).replace(/# review-trace-hooks:start\n\s*# review-trace-hooks:end\n?/, "");

    if (removed === existing) return false;
    const next = removed.replace(/\n{3,}/g, "\n\n");
    await writeFile(
      configPath,
      next.trim() ? `${next.trimEnd()}\n` : "",
      "utf8",
    );

    return true;
  }

  const extensionPath =
    agent === "pi"
      ? piExtensionPath(homeDir)
      : openCodePluginPath(homeDir, env);

  if (!existsSync(extensionPath)) return false;
  const existing = await readFile(extensionPath, "utf8");

  if (extensionOwner(existing) !== owner) {
    return false;
  }

  await rm(extensionPath, { force: true });

  return true;
}

function shellCommand(command: string): string {
  return command === traceCliName() ? command : shellQuote(command);
}

function codexTraceHookToml(
  eventName: "SessionStart" | "UserPromptSubmit" | "SessionEnd",
  reviewCommand: string,
): string {
  const status =
    eventName === "SessionStart"
      ? '\nstatusMessage = "Recording agent session id for trace stamping"'
      : "";

  return `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = ${JSON.stringify(`${shellCommand(reviewCommand)} trace hook ${eventName}`)}${status}`;
}

/** The whole marked block, written when the Codex config is empty. */
function codexHookBlock(reviewCommand: string): string {
  const events = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

  return `\n# review-trace-hooks:start\n${events
    .map((eventName) => codexTraceHookToml(eventName, reviewCommand))
    .join("\n\n")}\n# review-trace-hooks:end\n`;
}

// Restrict edits to the lifecycle blocks we generate, never arbitrary TOML keys.
// JSON basic strings are also valid TOML strings; parse the same emitted subset.
function transformCodexHooks(
  content: string,
  transform: (block: string, command: string, event: string) => string,
): string {
  return content.replace(
    /^\[\[hooks\.(SessionStart|UserPromptSubmit|SessionEnd)\]\]\n\[\[hooks\.\1\.hooks\]\]\ntype = "command"\ncommand = ("(?:[^"\\\n]|\\.)*")(?:\n|$)(?:statusMessage = "[^"\n]*"(?:\n|$))?/gm,
    (block: string, event: string, encoded: string, offset: number) => {
      // A generated prefix is not proof of an entire owned group. Extra keys
      // and later child tables still depend on the parent header we remove.
      let reachedOtherTable = false;

      for (const line of content.slice(offset + block.length).split("\n")) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) continue;

        if (!trimmed.startsWith("[")) {
          if (!reachedOtherTable) return block;
          continue;
        }

        const header = /^\[{1,2}([A-Za-z0-9_.-]+)\]{1,2}(?:\s*#.*)?$/.exec(
          trimmed,
        );

        // Unrecognized table syntax is preserved rather than guessed at.
        if (!header) return block;

        if (trimmed === `[[hooks.${event}]]`) break;

        if (
          header[1] === `hooks.${event}` ||
          header[1].startsWith(`hooks.${event}.`)
        )
          return block;
        reachedOtherTable = true;
      }

      try {
        const command = jsonString(parseJsonText(encoded));

        if (!command?.endsWith(` trace hook ${event}`)) return block;

        return transform(block, command, event);
      } catch {
        return block;
      }
    },
  );
}

export interface TraceHookOwners {
  claude: TraceHookOwner | null;
  codex: TraceHookOwner | null;
  opencode: TraceHookOwner | null;
  pi: TraceHookOwner | null;
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : "";
}

/**
 * The directory one harness keeps its own configuration in. A machine without
 * that directory does not run the harness, so an install writes it no hook.
 */
export function agentTraceHomeDirectory(
  agent: AgentTraceHookAgent,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent === "claude") return path.join(homeDir, ".claude");

  if (agent === "codex") return path.join(homeDir, ".codex");

  if (agent === "opencode") return openCodeDirectory(homeDir, env);

  if (agent === "pi") return path.join(homeDir, ".pi");
  const _exhaustive: never = agent;

  throw new Error(`Unknown trace hook agent: ${String(_exhaustive)}`);
}

/** The file one harness reads its trace hook from. */
export function agentTraceHookPath(
  agent: AgentTraceHookAgent,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent === "claude") return claudeSettingsPath(homeDir);

  if (agent === "codex") return codexConfigPath(homeDir);

  if (agent === "opencode") return openCodePluginPath(homeDir, env);

  if (agent === "pi") return piExtensionPath(homeDir);
  const _exhaustive: never = agent;

  throw new Error(`Unknown trace hook agent: ${String(_exhaustive)}`);
}

/** Reports recognized SessionStart owners and extension owners without changing files. */
export async function describeTraceHookOwners(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<TraceHookOwners> {
  let claude: TraceHookOwner | null = null;

  try {
    const parsed = parseJsonText(
      await readTextOrEmpty(claudeSettingsPath(homeDir)),
    );

    const hooks = isJsonObject(parsed) ? parsed.hooks : undefined;
    const groups = isJsonObject(hooks) ? hooks.SessionStart : undefined;

    for (const group of isJsonArray(groups) ? groups : []) {
      if (!isJsonObject(group) || !isJsonArray(group.hooks)) continue;

      for (const hook of group.hooks) {
        const owner = isJsonObject(hook)
          ? traceHookCommandOwner(hook.command)
          : null;

        if (owner) claude = owner;
      }
    }
  } catch {
    claude = null;
  }

  let codex: TraceHookOwner | null = null;
  transformCodexHooks(
    await readTextOrEmpty(codexConfigPath(homeDir)),
    (block, command, event) => {
      if (event === "SessionStart")
        codex = traceHookCommandOwner(command) ?? codex;

      return block;
    },
  );

  return {
    claude,
    codex,
    opencode: extensionOwner(
      await readTextOrEmpty(openCodePluginPath(homeDir, env)),
    ),
    pi: extensionOwner(await readTextOrEmpty(piExtensionPath(homeDir))),
  };
}
