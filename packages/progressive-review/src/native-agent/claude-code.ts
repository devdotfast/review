import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readClaudeReviewMessages } from "./claude-transcript";
import type {
  HarnessDialect,
  NativeTerminalInput,
  TerminalCommandInput,
} from "./harness";
import { HookObservedAgentServer } from "./hook-observed-server";
import type { AgentServer, AgentServerOptions } from "./native-session";
import { nativeHookCommand } from "./terminal-command";

const OBSERVER_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

export const dialect: HarnessDialect = {
  harness: "claude-code",

  // Claude accepts a caller-chosen id (`--session-id`), so reserving one
  // is just minting it. The session exists once the terminal starts.
  async reserveSessionId(input) {
    if (input.session && "resume" in input.session) {
      return input.session.resume;
    }
    return randomUUID();
  },

  async terminalCommand(input) {
    const settingsPath = await writeSettings(input);
    const args = [
      "--settings",
      settingsPath,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Bash",
      "--tools",
      "Bash",
      "Glob",
      "Grep",
      "Read",
    ];
    if (input.session && "forkOf" in input.session) {
      args.push(
        "--resume",
        input.session.forkOf,
        "--fork-session",
        "--session-id",
        input.sessionId,
      );
    } else if (input.session) {
      args.push("--resume", input.session.resume);
    } else {
      args.push("--session-id", input.sessionId);
    }
    if (input.prompt !== undefined) args.push(input.prompt);
    return {
      launchId: input.launchId,
      harness: "claude-code",
      cwd: input.cwd,
      executable: "claude",
      args,
      env: {
        ...input.env,
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
      },
    } satisfies NativeTerminalInput;
  },

  readMessages: readClaudeReviewMessages,
};

async function writeSettings(input: TerminalCommandInput): Promise<string> {
  const launchDirectory = join(input.runtimeDirectory, input.launchId);
  const settingsPath = join(launchDirectory, "claude-settings.json");
  await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
  const observerHook = { command: nativeHookCommand(), type: "command" };
  const hooks = Object.fromEntries(
    OBSERVER_EVENTS.map((event) => [event, [{ hooks: [observerHook] }]]),
  );
  await writeFile(settingsPath, `${JSON.stringify({ hooks })}\n`, "utf8");
  return settingsPath;
}

export function server(options: AgentServerOptions): AgentServer {
  return new HookObservedAgentServer(dialect, options);
}
