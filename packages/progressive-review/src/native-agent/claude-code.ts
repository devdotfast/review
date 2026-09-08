import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type JsonObject,
  type JsonValue,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import {
  type ClaudeReviewMessage,
  readClaudeReviewMessages,
} from "./claude-transcript";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeTerminalCommand,
  SessionSnapshot,
  SessionUpdate,
  UpdatePipe,
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
  "SessionEnd",
] as const;

interface SessionState {
  transcriptPath?: string;
  subscribers: Set<Subscriber>;
  refresh: Promise<void>;
  pendingPrompt?: {
    promptId: string | null;
    accepted: NonNullable<LaunchInput["prompt"]>["accepted"];
  };
}

interface Subscriber {
  queue: AsyncQueue<SessionUpdate>;
  /** Native IDs already delivered, in transcript order. */
  deliveredIds: string[];
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
  readonly #threadEnvironment: Record<string, string>;
  readonly #commandPath: ReviewCommandPath;
  readonly #readTranscript: typeof readClaudeReviewMessages;
  readonly #sessions = new Map<string, SessionState>();
  readonly #ingress: LoopbackIngress;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: ClaudeAgentServerOptions) {
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#threadEnvironment = reviewThreadEnvironment(options.desktopEndpoint);
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
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }
    const state = this.#session(sessionId);
    if (input.prompt) {
      if (state.pendingPrompt)
        throw new Error("Claude already has a pending Review prompt.");
      await input.prompt.prepared(sessionId);
      state.pendingPrompt = {
        promptId: null,
        accepted: input.prompt.accepted,
      };
      args.push(input.prompt.text);
    }
    const env: NativeTerminalCommand["env"] = {
      [REVIEW_AGENT_HOOK_URL_ENV]: `${hookBaseUrl}/${sessionPath}`,
      [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#ingress.token,
      ...this.#threadEnvironment,
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
    };
    if (pathValue) env.PATH = pathValue;
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

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const state = this.#session(sessionId);
    const messages = await this.#read(sessionId, state);
    const subscriber: Subscriber = {
      queue: new AsyncQueue<SessionUpdate>(),
      deliveredIds: messages.map((message) => message.id),
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
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    const pending: Promise<void>[] = [];
    for (const state of this.#sessions.values()) {
      pending.push(state.refresh);
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

  async #receiveHook(sessionId: string, payload: JsonValue): Promise<void> {
    const record = jsonObject(payload);
    if (!record) throw new Error("Claude posted a non-object hook payload.");
    const event = hookEvent(record);
    if (event.sessionId !== sessionId) {
      throw new Error(
        `A native hook for session "${event.sessionId}" was posted to session "${sessionId}".`,
      );
    }
    const state = this.#session(sessionId);
    state.transcriptPath = event.transcriptPath;
    if (
      event.type === "UserPromptSubmit" &&
      state.pendingPrompt?.promptId === null
    ) {
      state.pendingPrompt.promptId = event.promptId;
    }
    await this.#refresh(sessionId, state);
    if (event.type === "Stop" || event.type === "SessionEnd") {
      // Hooks can fire before Claude flushes the transcript, including the
      // initial user record. Retry acceptance as well as subscriber delivery.
      for (const delay of [250, 1_000]) {
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          void this.#refresh(sessionId, state).catch(console.error);
        }, delay);
        this.#timers.add(timer);
        timer.unref();
      }
    }
  }

  #refresh(sessionId: string, state: SessionState): Promise<void> {
    const refresh = state.refresh.then(async () => {
      const pending = state.pendingPrompt;
      if (pending && pending.promptId !== null) {
        const messages = await this.#read(sessionId, state);
        const matching = messages.filter(
          (message) =>
            message.role === "user" && message.promptId === pending.promptId,
        );
        if (matching.length > 1)
          throw new Error(
            "Claude recorded multiple user messages for the submitted prompt ID.",
          );
        const submitted = matching[0];
        if (submitted) {
          await pending.accepted(sessionId, submitted.id);
          state.pendingPrompt = undefined;
        }
      }
      this.#wake(sessionId, state);
    });
    // A failed hook must report its error without poisoning later hook reads.
    state.refresh = refresh.catch(() => {});
    return refresh;
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { subscribers: new Set(), refresh: Promise.resolve() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #wake(sessionId: string, state: SessionState): void {
    for (const subscriber of state.subscribers) {
      if (subscriber.wakePending) continue;
      subscriber.wakePending = true;
      subscriber.reading = subscriber.reading
        .then(async () => {
          subscriber.wakePending = false;
          if (!state.subscribers.has(subscriber)) return;
          const messages = await this.#read(sessionId, state);
          if (
            subscriber.deliveredIds.some(
              (id, index) => messages[index]?.id !== id,
            )
          ) {
            state.subscribers.delete(subscriber);
            subscriber.queue.close();
            throw new Error(
              "Claude transcript history changed; stopped mirroring this conversation.",
            );
          }
          for (const message of messages.slice(
            subscriber.deliveredIds.length,
          )) {
            subscriber.deliveredIds.push(message.id);
            subscriber.queue.push({ type: "message.updated", message });
          }
        })
        .catch(console.error);
    }
  }

  async #read(
    sessionId: string,
    state: SessionState,
  ): Promise<ClaudeReviewMessage[]> {
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

function isMissingTranscript(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if ("code" in cause && cause.code === "ENOENT") return true;
  return / has no transcript file\.$/u.test(cause.message);
}

type NativeHookEvent = {
  sessionId: string;
  transcriptPath: string;
} & (
  | { type: "SessionStart" | "Stop" | "SessionEnd" }
  | { type: "UserPromptSubmit"; promptId: string }
);

function hookEvent(payload: JsonObject): NativeHookEvent {
  const sessionId = jsonString(payload.session_id);
  const transcriptPath = jsonString(payload.transcript_path);
  const type = jsonString(payload.hook_event_name);
  if (!sessionId || !transcriptPath)
    throw new Error("Claude hook requires session_id and transcript_path.");
  if (type === "UserPromptSubmit") {
    const promptId = jsonString(payload.prompt_id);
    if (!promptId)
      throw new Error(
        "Claude UserPromptSubmit requires prompt_id (Claude Code 2.1.196 or later).",
      );
    return { sessionId, transcriptPath, type, promptId };
  }
  if (type === "SessionStart" || type === "Stop" || type === "SessionEnd") {
    return { sessionId, transcriptPath, type };
  }
  throw new Error("Claude posted an unsupported hook event.");
}

export function server(options: ClaudeAgentServerOptions): AgentServer {
  return new ClaudeAgentServer(options);
}
