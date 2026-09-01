import { DEV_REVIEW_HOME_ENV } from "../review-storage";
import { forkCodexThread, startCodexThread } from "./codex-app-server";
import type { HarnessDialect, NativeTerminalInput } from "./harness";
import { nativeHookCommand, tomlInline } from "./terminal-command";

const OBSERVER_EVENTS = ["UserPromptSubmit", "Stop"] as const;

export interface CodexDialectDependencies {
  startCodexThread?: typeof startCodexThread;
  forkCodexThread?: typeof forkCodexThread;
}

export function createDialect(
  dependencies: CodexDialectDependencies = {},
): HarnessDialect {
  const start = dependencies.startCodexThread ?? startCodexThread;
  const fork = dependencies.forkCodexThread ?? forkCodexThread;
  return {
    harness: "codex",

    // `codex resume <id>` needs the thread to exist, and Codex picks its own
    // ids, so new and forked threads are created through the app-server first.
    async reserveSessionId(input) {
      if (!input.session) return start({ cwd: input.cwd });
      if ("resume" in input.session) return input.session.resume;
      return fork({ sourceThreadId: input.session.forkOf, cwd: input.cwd });
    },

    async terminalCommand(input) {
      const args = ["--enable", "hooks"];
      const pathValue = input.env.PATH;
      if (pathValue) {
        args.push(
          "-c",
          `shell_environment_policy.set.PATH=${tomlInline(pathValue)}`,
        );
      }
      const reviewHome = input.env[DEV_REVIEW_HOME_ENV];
      if (!reviewHome) {
        throw new Error(`Codex launch env is missing ${DEV_REVIEW_HOME_ENV}.`);
      }
      args.push(
        "-c",
        `shell_environment_policy.set.${DEV_REVIEW_HOME_ENV}=${tomlInline(reviewHome)}`,
      );
      for (const hookEvent of OBSERVER_EVENTS) {
        args.push(
          "-c",
          `hooks.${hookEvent}=${tomlInline([
            {
              hooks: [
                { command: nativeHookCommand(), timeout: 60, type: "command" },
              ],
              matcher: "*",
            },
          ])}`,
        );
      }
      args.push("resume", "--dangerously-bypass-hook-trust", input.sessionId);
      if (input.prompt !== undefined) args.push(input.prompt);
      return {
        launchId: input.launchId,
        harness: "codex",
        cwd: input.cwd,
        executable: "codex",
        args,
        env: input.env,
      } satisfies NativeTerminalInput;
    },
  };
}

export const dialect = createDialect();
