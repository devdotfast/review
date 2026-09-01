import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import { readClaudeReviewMessages } from "./claude-transcript";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
  NativeTerminalCommand,
  SessionSnapshot,
  SessionUpdate,
  UpdatePipe,
} from "./native-session";
import {
  REVIEW_AGENT_HOOK_TOKEN_ENV,
  REVIEW_AGENT_HOOK_URL_ENV,
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
  nativeHookCommand,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

const OBSERVER_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

interface SessionState {
  transcriptPath?: string;
  subscribers: Set<Subscriber>;
}

interface Subscriber {
  queue: AsyncQueue<SessionUpdate>;
  /** Messages already delivered, so re-reads only emit the tail. */
  delivered: number;
  /** Serializes transcript re-reads per subscriber; wakes coalesce. */
  reading: Promise<void>;
  wakePending: boolean;
}

export type ClaudeAgentServerOptions = AgentServerOptions & {
  /** Test seam for the transcript reader. */
  readTranscript?: typeof readClaudeReviewMessages;
};

/**
 * Claude Code has no server of its own, so this one is simulated: the
 * terminal runs with a settings file that posts every lifecycle hook to
 * this server's loopback ingress, and each hook is a signal to re-read the
 * transcript on disk and forward whatever is new.
 */
export class ClaudeAgentServer implements AgentServer {
  readonly harness = "claude-code" as const;
  readonly #runtimeDirectory: string;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #readTranscript: typeof readClaudeReviewMessages;
  readonly #sessions = new Map<string, SessionState>();
  readonly #ingress: LoopbackIngress;

  constructor(options: ClaudeAgentServerOptions) {
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
    this.#readTranscript = options.readTranscript ?? readClaudeReviewMessages;
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
    if (input.prompt !== undefined) args.push(input.prompt);
    this.#session(sessionId);
    return {
      sessionId,
      command: {
        cwd: input.cwd,
        executable: "claude",
        args,
        env: {
          [REVIEW_AGENT_HOOK_URL_ENV]: `${hookBaseUrl}/${sessionPath}`,
          [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#ingress.token,
          [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/${sessionPath}/thread`,
          [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
          [DEV_REVIEW_HOME_ENV]: devReviewHome(),
          ...(pathValue ? { PATH: pathValue } : {}),
          CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        },
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const state = this.#session(sessionId);
    const messages = await this.#read(sessionId, state);
    const subscriber: Subscriber = {
      queue: new AsyncQueue<SessionUpdate>(),
      delivered: messages.length,
      reading: Promise.resolve(),
      wakePending: false,
    };
    state.subscribers.add(subscriber);
    return {
      snapshot: { sessionId, messages },
      updates: subscriber.queue,
      close: async () => {
        state.subscribers.delete(subscriber);
        subscriber.queue.close();
        await subscriber.reading;
      },
    };
  }

  async close(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const state of this.#sessions.values()) {
      for (const subscriber of state.subscribers) {
        subscriber.queue.close();
        pending.push(subscriber.reading);
      }
      state.subscribers.clear();
    }
    await Promise.all(pending);
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

  #receiveHook(sessionId: string, payload: unknown): void {
    if (!isJsonRecord(payload)) return;
    const event = hookEvent(payload);
    if (event.sessionId && event.sessionId !== sessionId) {
      throw new Error(
        `A native hook for session "${event.sessionId}" was posted to session "${sessionId}".`,
      );
    }
    const state = this.#session(sessionId);
    if (event.transcriptPath) state.transcriptPath = event.transcriptPath;
    this.#wake(sessionId, state);
    if (event.completesTurn) {
      // Hooks can fire before Claude flushes the transcript.
      for (const delay of [250, 1_000]) {
        const timer = setTimeout(() => this.#wake(sessionId, state), delay);
        timer.unref();
      }
    }
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { subscribers: new Set() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #wake(sessionId: string, state: SessionState): void {
    for (const subscriber of state.subscribers) {
      if (subscriber.wakePending) continue;
      subscriber.wakePending = true;
      subscriber.reading = subscriber.reading.then(async () => {
        subscriber.wakePending = false;
        if (!state.subscribers.has(subscriber)) return;
        const messages = await this.#read(sessionId, state);
        for (const message of messages.slice(subscriber.delivered)) {
          subscriber.delivered += 1;
          subscriber.queue.push({ type: "message.updated", message });
        }
      });
    }
  }

  async #read(
    sessionId: string,
    state: SessionState,
  ): Promise<NativeReviewMessage[]> {
    try {
      return await this.#readTranscript({
        sessionId,
        transcriptPath: state.transcriptPath,
      });
    } catch (error) {
      // The first hooks can fire before Claude creates its transcript.
      if (isMissingTranscript(error)) return [];
      throw error;
    }
  }
}

function isMissingTranscript(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return / has no transcript file\.$/u.test(error.message);
}

function hookEvent(payload: Record<string, unknown>): {
  sessionId?: string;
  transcriptPath?: string;
  completesTurn: boolean;
} {
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const transcriptPath = firstString(
    payload.transcript_path,
    payload.transcriptPath,
  );
  const name = firstString(
    payload.hook_event_name,
    payload.hookEventName,
  )?.toLowerCase();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    completesTurn: name === "stop" || name === "sessionend",
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function server(options: ClaudeAgentServerOptions): AgentServer {
  return new ClaudeAgentServer(options);
}
