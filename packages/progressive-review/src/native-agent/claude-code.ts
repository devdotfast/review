import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type JsonValue,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { LiveCapture } from "./live-capture";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeTerminalCommand,
  SessionUpdateStream,
} from "./native-session";
import {
  REVIEW_AGENT_HOOK_TOKEN_ENV,
  REVIEW_AGENT_HOOK_URL_ENV,
  ReviewCommandPath,
  nativeHookCommand,
  reviewThreadEnvironment,
} from "./terminal-command";

const OBSERVER_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

export class ClaudeAgentServer implements AgentServer {
  readonly harness = "claude-code" as const;
  readonly #runtimeDirectory: string;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, LiveCapture>();
  readonly #ingress: LoopbackIngress;

  constructor(options: AgentServerOptions) {
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
    this.#ingress = new LoopbackIngress({
      scope: this.harness,
      onPost: (sessionId, payload) => this.#receiveHook(sessionId, payload),
    });
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; command: NativeTerminalCommand }> {
    // Claude accepts a caller-chosen id (`--session-id`), so a new or forked
    // session is minted here and exists once the terminal starts.
    const sessionId =
      input.session && "resume" in input.session
        ? input.session.resume
        : randomUUID();
    const sessionPath = `${this.harness}/${encodeURIComponent(sessionId)}`;
    const hookBaseUrl = await this.#ingress.url();
    const pathValue = await this.#commandPath.resolve();
    const settingsPath = await this.#writeSettings();
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
        sessionId,
      );
    } else if (input.session) {
      args.push("--resume", input.session.resume);
    } else {
      args.push("--session-id", sessionId);
    }
    if (input.prompt !== undefined) args.push(input.prompt.text);
    const capture = this.#sessions.get(sessionId) ?? new LiveCapture();
    const launchId = capture.launch(input.prompt);
    this.#sessions.set(sessionId, capture);
    const env: NativeTerminalCommand["env"] = {
      DEV_FAST_REVIEW_AGENT_LAUNCH_ID: launchId,
      [REVIEW_AGENT_HOOK_URL_ENV]: `${hookBaseUrl}/${sessionPath}`,
      [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#ingress.token,
      ...reviewThreadEnvironment(this.#desktop),
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
    };
    if (pathValue) env.PATH = pathValue;
    Object.assign(env, input.environment);
    return {
      sessionId,
      command: {
        cwd: input.cwd,
        executable: "claude",
        args,
        env,
      },
    };
  }

  async updates(sessionId: string): Promise<SessionUpdateStream> {
    return this.#session(sessionId).subscribe();
  }

  async interrupt(sessionId: string): Promise<void> {
    this.#session(sessionId).interrupt();
  }

  async close(): Promise<void> {
    for (const capture of this.#sessions.values()) capture.queue.close();
    await this.#ingress.close();
  }

  /** The observer settings never vary per launch, so one file serves every terminal. */
  async #writeSettings(): Promise<string> {
    const settingsPath = join(this.#runtimeDirectory, "claude-settings.json");
    await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    const observerHook = { command: nativeHookCommand(), type: "command" };
    const hooks = Object.fromEntries(
      OBSERVER_EVENTS.map((event) => [event, [{ hooks: [observerHook] }]]),
    );
    await writeFile(settingsPath, `${JSON.stringify({ hooks })}\n`, "utf8");
    return settingsPath;
  }

  #receiveHook(sessionId: string, payload: JsonValue): void {
    const record = jsonObject(payload);
    if (!record || jsonString(record.session_id) !== sessionId) {
      throw new Error(`The Claude hook must name session "${sessionId}".`);
    }
    const event = jsonString(record.hook_event_name);
    const eventId = jsonString(record.review_event_id);
    if (!eventId) throw new Error("The Claude hook has no observer event ID.");
    const capture = this.#session(sessionId);
    const launchId = jsonString(record.review_launch_id);
    if (!launchId) throw new Error("The observer event has no launch ID.");
    if (!capture.accepts(launchId)) return;
    if (event === "UserPromptSubmit" || event === "Stop") {
      const body = jsonString(
        event === "UserPromptSubmit"
          ? record.prompt
          : record.last_assistant_message,
      );
      if (body === undefined)
        throw new Error("The Claude hook has no message text.");
      capture.message({
        id: eventId,
        role: event === "UserPromptSubmit" ? "user" : "assistant",
        body,
        createdAt: new Date().toISOString(),
      });
      capture.status(event === "UserPromptSubmit" ? "running" : "idle");
    } else if (event === "StopFailure") {
      const error = jsonString(record.error);
      if (!error) throw new Error("Claude StopFailure has no error.");
      capture.status("failed", error);
    } else if (event === "SessionEnd") {
      capture.interrupt();
    } else if (event !== "SessionStart") {
      throw new Error("Unsupported Claude hook event.");
    }
  }

  #session(sessionId: string): LiveCapture {
    const capture = this.#sessions.get(sessionId);
    if (!capture)
      throw new Error(`Claude session "${sessionId}" has not been launched.`);
    return capture;
  }
}

export function server(options: AgentServerOptions): AgentServer {
  return new ClaudeAgentServer(options);
}
