import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import type { HarnessDialect, NativeTerminalCommand } from "./harness";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
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
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

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

/**
 * An AgentServer for harnesses that have no server of their own. The
 * terminal's native hooks post to this server's loopback ingress, and each
 * hook is a signal to re-read the transcript and forward whatever is new.
 * Nothing here is harness-specific: the dialect supplies the command line
 * and the reader.
 */
export class HookObservedAgentServer implements AgentServer {
  readonly harness: HarnessDialect["harness"];
  readonly #dialect: HarnessDialect;
  readonly #runtimeDirectory: string;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();
  readonly #ingress: LoopbackIngress;

  constructor(dialect: HarnessDialect, options: AgentServerOptions) {
    this.harness = dialect.harness;
    this.#dialect = dialect;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
    this.#ingress = new LoopbackIngress({
      scope: this.harness,
      onPost: (sessionId, payload) =>
        this.#receiveHookEvent(sessionId, payload),
    });
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; command: NativeTerminalCommand }> {
    const sessionId = await this.#dialect.reserveSessionId({
      session: input.session,
      cwd: input.cwd,
    });
    const hookBaseUrl = await this.#ingress.url();
    const sessionPath = `${this.harness}/${encodeURIComponent(sessionId)}`;
    const pathValue = await this.#commandPath.resolve();
    const command = await this.#dialect.terminalCommand({
      session: input.session,
      sessionId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      cwd: input.cwd,
      env: {
        // Native hooks report to this server's own listener.
        [REVIEW_AGENT_HOOK_URL_ENV]: `${hookBaseUrl}/${sessionPath}`,
        [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#ingress.token,
        // `review threads get` inside the terminal reads its thread from the
        // desktop, which every implementation needs regardless of observation.
        [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/${sessionPath}/thread`,
        [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
        [DEV_REVIEW_HOME_ENV]: devReviewHome(),
        ...(pathValue ? { PATH: pathValue } : {}),
      },
      runtimeDirectory: this.#runtimeDirectory,
    });
    this.#session(sessionId);
    return { sessionId, command };
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

  #receiveHookEvent(sessionId: string, payload: unknown): void {
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
      // Hooks can fire before the harness flushes the transcript.
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
  completesTurn: boolean;
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
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    completesTurn:
      name === "stop" || name === "sessionend" || name === "agent_settled",
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
