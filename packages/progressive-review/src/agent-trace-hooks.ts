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
} from "@dev.fast/review-protocol";

export interface AgentTraceHookInstallResult {
  agent: "claude" | "codex" | "pi";
  path: string;
  modified: boolean;
}

const PI_EXTENSION_MARKER = "Managed by Review Desktop trace setup";

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

  proc.stdin.end(payload);
}
`;
}

const CODEX_HOOK_TOML = `
# review-trace-hooks:start
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "review trace hook SessionStart"
statusMessage = "Recording agent session id for trace stamping"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "review trace hook UserPromptSubmit"

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "review trace hook SessionEnd"
# review-trace-hooks:end
`;

/**
 * Idempotently configures Claude Code session lifecycle hooks in ~/.claude/settings.json.
 */
export async function installClaudeTraceHook(
  homeDir = os.homedir(),
  reviewCommand = "review",
): Promise<AgentTraceHookInstallResult> {
  const settingsDir = path.join(homeDir, ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");

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
    const existingGroup: JsonValue[] = isJsonArray(existing) ? existing : [];
    const hasHook = existingGroup.some((entry) => {
      if (!isJsonObject(entry)) return false;
      const subHooks = entry.hooks;
      if (isJsonArray(subHooks)) {
        return subHooks.some(
          (h) => isJsonObject(h) && isReviewTraceHookCommand(h.command),
        );
      }
      return false;
    });

    if (!hasHook) {
      existingGroup.push({
        hooks: [hookCommand(eventName)],
      });
      hooks[eventName] = existingGroup;
      modified = true;
    }
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
  reviewCommand = "review",
): Promise<AgentTraceHookInstallResult> {
  const codexDir = path.join(homeDir, ".codex");
  const configPath = path.join(codexDir, "config.toml");

  let existing = "";
  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf8");
  }

  const hookEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "SessionEnd",
  ] as const;
  const missingEvents = hookEvents.filter(
    (eventName) => !existing.includes(` trace hook ${eventName}`),
  );
  if (missingEvents.length === 0) {
    return { agent: "codex", path: configPath, modified: false };
  }

  const codexHookToml = CODEX_HOOK_TOML.replaceAll(
    "review trace hook",
    `${shellCommand(reviewCommand)} trace hook`,
  );
  const missingHookToml = missingEvents
    .map((eventName) => codexTraceHookToml(eventName, reviewCommand))
    .join("\n\n");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    configPath,
    existing
      ? `${existing.trimEnd()}\n\n${missingHookToml.trim()}\n`
      : codexHookToml.trimStart(),
    "utf8",
  );

  return { agent: "codex", path: configPath, modified: true };
}

/**
 * Idempotently writes the Pi session lifecycle extension into ~/.pi/agent/extensions/review-trace.ts.
 */
export async function installPiTraceExtension(
  homeDir = os.homedir(),
  reviewCommand = "review",
): Promise<AgentTraceHookInstallResult> {
  const extensionsDir = path.join(homeDir, ".pi", "agent", "extensions");
  const extensionPath = path.join(extensionsDir, "review-trace.ts");

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

/** Removes only lifecycle hooks that Review owns for one agent. */
export async function removeAgentTraceHook(
  agent: "claude" | "codex" | "pi",
  homeDir = os.homedir(),
): Promise<boolean> {
  if (agent === "claude") {
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
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
          const owned = isReviewTraceHookCommand(command);
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
    const configPath = path.join(homeDir, ".codex", "config.toml");
    if (!existsSync(configPath)) return false;
    const existing = await readFile(configPath, "utf8");
    const marked =
      /# review-trace-hooks:start\n[\s\S]*?# review-trace-hooks:end\n?/;
    const withoutMarkedBlock = existing
      .replace(marked, "")
      .replace(CODEX_HOOK_TOML.trim(), "");
    const removed = ["SessionStart", "UserPromptSubmit", "SessionEnd"].reduce(
      (content, eventName) => removeCodexTraceHook(content, eventName),
      withoutMarkedBlock,
    );
    if (removed === existing) return false;
    const next = removed.replace(/\n{3,}/g, "\n\n");
    await writeFile(
      configPath,
      next.trim() ? `${next.trimEnd()}\n` : "",
      "utf8",
    );
    return true;
  }

  const extensionPath = path.join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "review-trace.ts",
  );
  if (!existsSync(extensionPath)) return false;
  const existing = await readFile(extensionPath, "utf8");
  if (!existing.trimStart().startsWith(`// ${PI_EXTENSION_MARKER}`)) {
    return false;
  }
  await rm(extensionPath, { force: true });
  return true;
}

function shellCommand(command: string): string {
  return command === "review"
    ? command
    : `'${command.replaceAll("'", `'"'"'`)}'`;
}

function isReviewTraceHookCommand(command: JsonValue | undefined): boolean {
  const text = jsonString(command);
  if (text === undefined) return false;
  const match =
    /^(.*) trace hook (SessionStart|UserPromptSubmit|SessionEnd)$/.exec(text);
  if (!match) return false;
  return match[1] === "review" || match[1].endsWith("/review'");
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
command = "${shellCommand(reviewCommand)} trace hook ${eventName}"${status}`;
}

function removeCodexTraceHook(content: string, eventName: string): string {
  const escapedEvent = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\n)\\[\\[hooks\\.${escapedEvent}\\]\\]\\n` +
      `\\[\\[hooks\\.${escapedEvent}\\.hooks\\]\\]\\n` +
      `type = "command"\\n` +
      `command = "[^"\\n]* trace hook ${escapedEvent}"\\n` +
      `(?:statusMessage = "[^"\\n]*"\\n)?`,
    "g",
  );
  return content.replace(pattern, "\n");
}
