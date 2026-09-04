import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type JsonValue,
  type ReviewVerbRequest,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { writePathShim } from "../server/cli-install";
import { forkCodexThread, startCodexThread } from "./codex-app-server";
import { NativeSessionObserverRegistry } from "./native-observer";
import type {
  LaunchReviewTurnInput,
  NativeTerminalHandle,
  ObservedNativeSession,
  ReviewAgentHarness,
  ReviewThreadAgentBinding,
} from "./native-session";

export const REVIEW_AGENT_HOOK_URL_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_URL";
export const REVIEW_AGENT_HOOK_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_TOKEN";
export const REVIEW_AGENT_THREAD_URL_ENV = "DEV_FAST_REVIEW_AGENT_THREAD_URL";

type NativeTerminalInput = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"];

export interface NativeReviewTurnLauncherInput {
  hookBaseUrl: string;
  hookToken: string;
  runtimeDirectory: string;
  reviewCliPath?: string;
  reviewCliRuntimePath?: string;
  openTerminal(input: NativeTerminalInput): Promise<void>;
  observer?: NativeSessionObserverRegistry;
  startCodexThread?: typeof startCodexThread;
  forkCodexThread?: typeof forkCodexThread;
}

export interface OpenNativeReviewSessionInput {
  launchId: string;
  cwd: string;
  binding: ReviewThreadAgentBinding;
}

/** Launches Review questions in normal native agent terminals. */
export class NativeReviewTurnLauncher {
  readonly #hookBaseUrl: string;
  readonly #hookToken: string;
  readonly #runtimeDirectory: string;
  readonly #reviewCliPath: string | undefined;
  readonly #reviewCliRuntimePath: string | undefined;
  readonly #openTerminal: NativeReviewTurnLauncherInput["openTerminal"];
  readonly #startCodexThread: typeof startCodexThread;
  readonly #forkCodexThread: typeof forkCodexThread;
  #reviewCommandDirectory: Promise<string | undefined> | undefined;
  readonly observer: NativeSessionObserverRegistry;

  constructor(input: NativeReviewTurnLauncherInput) {
    this.#hookBaseUrl = input.hookBaseUrl.replace(/\/$/u, "");
    this.#hookToken = input.hookToken;
    this.#runtimeDirectory = input.runtimeDirectory;
    this.#reviewCliPath = input.reviewCliPath;
    this.#reviewCliRuntimePath = input.reviewCliRuntimePath;
    this.#openTerminal = input.openTerminal;
    this.#startCodexThread = input.startCodexThread ?? startCodexThread;
    this.#forkCodexThread = input.forkCodexThread ?? forkCodexThread;
    this.observer = input.observer ?? new NativeSessionObserverRegistry();
  }

  async launchTurn(
    input: LaunchReviewTurnInput,
  ): Promise<NativeTerminalHandle> {
    const harness =
      input.route.kind === "fork"
        ? input.route.source.harness
        : input.route.kind === "resume"
          ? input.route.session.harness
          : input.route.harness;
    const requestedSessionId = await this.#requestedSessionId(input, harness);
    const handle = this.observer.beginLaunch({
      launchId: input.launchId,
      harness,
      expectedSessionId: requestedSessionId,
    });
    try {
      const terminal = await this.#terminalInput(
        input,
        harness,
        requestedSessionId,
      );
      await this.#openTerminal(terminal);
      return handle;
    } catch (error) {
      this.observer.observerFailed(input.launchId, error);
      await handle.detach();
      throw error;
    }
  }

  observe(binding: ReviewThreadAgentBinding): ObservedNativeSession {
    return this.observer.observe(binding);
  }

  async openSession(
    input: OpenNativeReviewSessionInput,
  ): Promise<NativeTerminalHandle> {
    const handle = this.observer.beginLaunch({
      launchId: input.launchId,
      harness: input.binding.harness,
      expectedSessionId: input.binding.sessionId,
    });
    try {
      await this.#openTerminal(
        await this.#terminalInput(
          {
            launchId: input.launchId,
            threadId: "",
            reviewMessageId: "",
            cwd: input.cwd,
            prompt: "",
            route: { kind: "resume", session: input.binding },
          },
          input.binding.harness,
          input.binding.sessionId,
          false,
        ),
      );
      return handle;
    } catch (error) {
      this.observer.observerFailed(input.launchId, error);
      await handle.detach();
      throw error;
    }
  }

  async #requestedSessionId(
    input: LaunchReviewTurnInput,
    harness: ReviewAgentHarness,
  ): Promise<string> {
    if (input.route.kind === "resume") return input.route.session.sessionId;
    if (input.route.kind === "new") {
      return harness === "codex"
        ? this.#startCodexThread({ cwd: input.cwd })
        : randomUUID();
    }
    if (harness === "codex") {
      return this.#forkCodexThread({
        sourceThreadId: input.route.source.sessionId,
        cwd: input.cwd,
      });
    }
    return randomUUID();
  }

  async #terminalInput(
    input: LaunchReviewTurnInput,
    harness: ReviewAgentHarness,
    requestedSessionId: string,
    submitPrompt = true,
  ): Promise<NativeTerminalInput> {
    const hookUrl = `${this.#hookBaseUrl}/${encodeURIComponent(input.launchId)}`;
    const pathValue = await this.#nativeAgentPath();
    const reviewHome = devReviewHome();
    const env: NativeTerminalInput["env"] = {
      [REVIEW_AGENT_HOOK_URL_ENV]: hookUrl,
      [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#hookToken,
      [REVIEW_AGENT_THREAD_URL_ENV]: `${hookUrl}/thread`,
      [DEV_REVIEW_HOME_ENV]: reviewHome,
    };
    if (pathValue) env.PATH = pathValue;
    switch (harness) {
      case "claude-code": {
        const settingsPath = await this.#writeClaudeSettings(input.launchId);
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
        if (input.route.kind === "fork") {
          args.push(
            "--resume",
            input.route.source.sessionId,
            "--fork-session",
            "--session-id",
            requestedSessionId,
          );
          if (submitPrompt) args.push(input.prompt);
        } else if (input.route.kind === "resume") {
          args.push("--resume", input.route.session.sessionId);
          if (submitPrompt) args.push(input.prompt);
        } else {
          args.push("--session-id", requestedSessionId);
          if (submitPrompt) args.push(input.prompt);
        }
        return {
          launchId: input.launchId,
          harness,
          cwd: input.cwd,
          executable: "claude",
          args,
          env: {
            ...env,
            CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
          },
        };
      }
      case "codex": {
        const args = ["--enable", "hooks"];
        if (pathValue) {
          args.push(
            "-c",
            `shell_environment_policy.set.PATH=${tomlInline(pathValue)}`,
          );
        }
        args.push(
          "-c",
          `shell_environment_policy.set.${DEV_REVIEW_HOME_ENV}=${tomlInline(reviewHome)}`,
        );
        for (const hookEvent of CODEX_OBSERVER_EVENTS) {
          args.push(
            "-c",
            `hooks.${hookEvent}=${tomlInline([
              {
                hooks: [
                  {
                    command: nativeHookCommand(),
                    timeout: 60,
                    type: "command",
                  },
                ],
                matcher: "*",
              },
            ])}`,
          );
        }
        args.push(
          "resume",
          "--dangerously-bypass-hook-trust",
          requestedSessionId,
        );
        if (submitPrompt) args.push(input.prompt);
        return {
          launchId: input.launchId,
          harness,
          cwd: input.cwd,
          executable: "codex",
          args,
          env,
        };
      }
      case "pi": {
        const args = [
          "-e",
          companionModulePath("pi-observer-extension"),
          "--tools",
          "bash,find,grep,ls,read",
        ];
        if (input.route.kind === "fork") {
          args.push(
            "--fork",
            input.route.source.sessionId,
            "--session-id",
            requestedSessionId,
          );
        } else if (input.route.kind === "resume") {
          args.push("--session", input.route.session.sessionId);
        } else {
          args.push("--session-id", requestedSessionId);
        }
        if (submitPrompt) args.push(input.prompt);
        return {
          launchId: input.launchId,
          harness,
          cwd: input.cwd,
          executable: "pi",
          args,
          env,
        };
      }
    }
  }

  async #nativeAgentPath(): Promise<string | undefined> {
    const commandDirectory = await this.#prepareReviewCommand();
    const inheritedPath = process.env.PATH;
    if (!commandDirectory) return inheritedPath;
    return inheritedPath
      ? `${commandDirectory}${delimiter}${inheritedPath}`
      : commandDirectory;
  }

  async #prepareReviewCommand(): Promise<string | undefined> {
    const reviewCliPath = this.#reviewCliPath;
    if (!reviewCliPath) return undefined;
    this.#reviewCommandDirectory ??= (async () => {
      const commandDirectory = join(this.#runtimeDirectory, "bin");
      try {
        await writePathShim(
          join(commandDirectory, "review"),
          reviewCliPath,
          this.#reviewCliRuntimePath,
        );
        return commandDirectory;
      } catch (error) {
        this.#reviewCommandDirectory = undefined;
        throw error;
      }
    })();
    return this.#reviewCommandDirectory;
  }

  async #writeClaudeSettings(launchId: string): Promise<string> {
    const launchDirectory = join(this.#runtimeDirectory, launchId);
    const settingsPath = join(launchDirectory, "claude-settings.json");
    await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
    const observerHook = {
      command: nativeHookCommand(),
      type: "command",
    };
    const hooks = Object.fromEntries(
      CLAUDE_OBSERVER_EVENTS.map((event) => [
        event,
        [{ hooks: [observerHook] }],
      ]),
    );
    await writeFile(settingsPath, `${JSON.stringify({ hooks })}\n`, "utf8");
    return settingsPath;
  }
}

const CLAUDE_OBSERVER_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

const CODEX_OBSERVER_EVENTS = ["UserPromptSubmit", "Stop"] as const;

function companionModulePath(name: string): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath) === ".ts" ? ".ts" : ".js";
  const direct = join(dirname(currentPath), `${name}${extension}`);
  if (extension === ".ts" || existsSync(direct)) return direct;
  return join(dirname(currentPath), "native-agent", `${name}${extension}`);
}

function nativeHookCommand(): string {
  const modulePath = companionModulePath("native-hook-client");
  const nodeArgs =
    extname(modulePath) === ".ts"
      ? [
          process.execPath,
          "--import",
          fileURLToPath(import.meta.resolve("tsx/esm")),
          modulePath,
        ]
      : [process.execPath, modulePath];
  const command =
    process.versions.electron === undefined
      ? nodeArgs
      : ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", ...nodeArgs];
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tomlInline(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlInline).join(", ")}]`;
  }
  if (isJsonObject(value)) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => {
        const name = /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
        return `${name} = ${tomlInline(entry)}`;
      })
      .join(", ")} }`;
  }
  if (value === null) {
    throw new TypeError("Codex hook configuration contains an invalid value.");
  }
  const text = jsonString(value);
  return text === undefined ? String(value) : JSON.stringify(text);
}
