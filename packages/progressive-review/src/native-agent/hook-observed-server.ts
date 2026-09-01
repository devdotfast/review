import { randomUUID } from "node:crypto";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import type { HarnessDialect, NativeTerminalInput } from "./harness";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
  SessionSnapshot,
  SessionStatus,
  SessionUpdate,
  UpdatePipe,
} from "./native-session";
import {
  REVIEW_AGENT_HOOK_TOKEN_ENV,
  REVIEW_AGENT_HOOK_URL_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

interface SessionState {
  status: SessionStatus;
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

/**
 * An AgentServer for harnesses that have no server of their own. The
 * terminal's native hooks post to Review, and each hook is a signal to
 * re-read the transcript and forward whatever is new. Nothing here is
 * harness-specific: the dialect supplies the command line and the reader.
 */
export class HookObservedAgentServer implements AgentServer {
  readonly harness: HarnessDialect["harness"];
  readonly #dialect: HarnessDialect;
  readonly #runtimeDirectory: string;
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();

  constructor(dialect: HarnessDialect, options: AgentServerOptions) {
    this.harness = dialect.harness;
    this.#dialect = dialect;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#commandPath = new ReviewCommandPath(options);
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; terminal: NativeTerminalInput }> {
    const sessionId = await this.#dialect.reserveSessionId({
      session: input.session,
      cwd: input.cwd,
    });
    const hookUrl = `${input.hookEndpoint.baseUrl.replace(/\/$/u, "")}/${this.harness}/${encodeURIComponent(sessionId)}`;
    const pathValue = await this.#commandPath.resolve();
    const terminal = await this.#dialect.terminalCommand({
      launchId: randomUUID(),
      session: input.session,
      sessionId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      cwd: input.cwd,
      env: {
        [REVIEW_AGENT_HOOK_URL_ENV]: hookUrl,
        [REVIEW_AGENT_HOOK_TOKEN_ENV]: input.hookEndpoint.token,
        [REVIEW_AGENT_THREAD_URL_ENV]: `${hookUrl}/thread`,
        [DEV_REVIEW_HOME_ENV]: devReviewHome(),
        ...(pathValue ? { PATH: pathValue } : {}),
      },
      runtimeDirectory: this.#runtimeDirectory,
    });
    this.#session(sessionId);
    return { sessionId, terminal };
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
      snapshot: { sessionId, status: state.status, messages },
      updates: subscriber.queue,
      close: async () => {
        state.subscribers.delete(subscriber);
        subscriber.queue.close();
        await subscriber.reading;
      },
    };
  }

  receiveHookEvent(sessionId: string, payload: unknown): void {
    if (!isJsonRecord(payload)) return;
    const event = hookEvent(payload);
    if (event.sessionId && event.sessionId !== sessionId) {
      throw new Error(
        `A native hook for session "${event.sessionId}" was posted to session "${sessionId}".`,
      );
    }
    const state = this.#session(sessionId);
    if (event.transcriptPath) state.transcriptPath = event.transcriptPath;
    if (state.status === "pending") {
      state.status = "idle";
      this.#broadcast(state, { type: "attached" });
    }
    switch (event.kind) {
      case "turn.started":
        state.status = "running";
        this.#broadcast(state, { type: "turn.started" });
        break;
      case "turn.completed":
        state.status = "idle";
        this.#broadcast(state, { type: "turn.completed" });
        break;
      case "closed":
        state.status = "closed";
        this.#broadcast(state, { type: "closed", reason: "session ended" });
        break;
      case "other":
        break;
    }
    this.#wake(sessionId, state);
    if (event.kind === "turn.completed" || event.kind === "closed") {
      // Hooks can fire before the harness flushes the transcript.
      for (const delay of [250, 1_000]) {
        const timer = setTimeout(() => this.#wake(sessionId, state), delay);
        timer.unref();
      }
    }
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
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { status: "pending", subscribers: new Set() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #broadcast(state: SessionState, update: SessionUpdate): void {
    for (const subscriber of state.subscribers) subscriber.queue.push(update);
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
      return await this.#dialect.readMessages({
        sessionId,
        transcriptPath: state.transcriptPath,
      });
    } catch (error) {
      // The first hooks can fire before the harness creates its transcript.
      if (isMissingTranscript(error)) return [];
      throw error;
    }
  }
}

function isMissingTranscript(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return / has no (?:rollout|transcript) file\.$/u.test(error.message);
}

function hookEvent(payload: Record<string, unknown>): {
  sessionId?: string;
  transcriptPath?: string;
  kind: "turn.started" | "turn.completed" | "closed" | "other";
} {
  const sessionId = firstString(
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
  );
  const transcriptPath = firstString(
    payload.transcript_path,
    payload.transcriptPath,
  );
  const name = firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload.event,
  )?.toLowerCase();
  const kind =
    name === "userpromptsubmit" || name === "message_start"
      ? "turn.started"
      : name === "stop" || name === "agent_settled"
        ? "turn.completed"
        : name === "sessionend" || name === "session_shutdown"
          ? "closed"
          : "other";
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    kind,
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
