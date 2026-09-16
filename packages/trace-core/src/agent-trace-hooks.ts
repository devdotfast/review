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

export interface AgentTraceHookInstallResult {
  agent: AgentTraceHookAgent;
  path: string;
  modified: boolean;
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

function openCodePluginPath(homeDir: string): string {
  return path.join(
    homeDir,
    ".config",
    "opencode",
    "plugins",
    "review-trace.ts",
  );
}

function executableOwner(file: string): TraceHookOwner | null {
  const base = path.basename(file);

  return base === "review" || base === "dev-traces" ? base : null;
}

/** Identifies a single executable lifecycle command; never accepts shell compounds. */
export function traceHookCommandOwner(
  command: JsonValue | undefined,
): TraceHookOwner | null {
  const text = jsonString(command);

  if (text === undefined) return null;

  const match =
    /^(.*) trace hook (SessionStart|UserPromptSubmit|SessionEnd)$/.exec(text);

  if (!match) return null;
  const prefix = match[1];

  if (/^[a-zA-Z0-9_./-]+$/.test(prefix)) return executableOwner(prefix);
  const decoded = prefix.slice(1, -1).replaceAll(`'"'"'`, "'");

  return shellQuote(decoded) === prefix ? executableOwner(decoded) : null;
}

function extensionOwner(source: string): TraceHookOwner | null {
  if (!source.trimStart().startsWith(`// ${PI_EXTENSION_MARKER}`)) return null;
  const match = /spawn\(("(?:[^"\\]|\\.)*"), \["trace", "hook"/.exec(source);

  if (!match) return null;
  const file = jsonString(parseJsonText(match[1]));

  return file === undefined ? null : executableOwner(file);
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
}): Promise<AgentTraceHookInstallResult[]> {
  if (input.harnessHooks === false) return [];

  return [
    await installClaudeTraceHook(input.homeDir, input.executable),
    await installCodexTraceHook(input.homeDir, input.executable),
    await installOpenCodeTraceExtension(input.homeDir, input.executable),
    await installPiTraceExtension(input.homeDir, input.executable),
  ];
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
        if (!isJsonObject(hook) || traceHookCommandOwner(hook.command) === null)
          continue;
        found = true;

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

  return { agent: "claude", path: settingsPath, modified };
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

  let next = transformCodexHooks(existing, (block, command, event) => {
    if (traceHookCommandOwner(command) === null) return block;
    found.add(event);

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

  if (next === existing)
    return { agent: "codex", path: configPath, modified: false };
  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, next, "utf8");

  return { agent: "codex", path: configPath, modified: true };
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
): Promise<AgentTraceHookInstallResult> {
  const pluginsDir = path.join(homeDir, ".config", "opencode", "plugins");
  const pluginPath = openCodePluginPath(homeDir);

  let existing = "";

  if (existsSync(pluginPath)) {
    existing = await readFile(pluginPath, "utf8");
  }

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
    agent === "pi" ? piExtensionPath(homeDir) : openCodePluginPath(homeDir);

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

/** The file one harness reads its trace hook from. */
export function agentTraceHookPath(
  agent: AgentTraceHookAgent,
  homeDir = os.homedir(),
): string {
  if (agent === "claude") return claudeSettingsPath(homeDir);

  if (agent === "codex") return codexConfigPath(homeDir);

  if (agent === "opencode") return openCodePluginPath(homeDir);

  return piExtensionPath(homeDir);
}

/** Reports recognized SessionStart owners and extension owners without changing files. */
export async function describeTraceHookOwners(
  homeDir = os.homedir(),
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
      await readTextOrEmpty(openCodePluginPath(homeDir)),
    ),
    pi: extensionOwner(await readTextOrEmpty(piExtensionPath(homeDir))),
  };
}
