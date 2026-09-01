import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { errorMessage } from "../error-message";
import { AsyncQueue } from "./async-queue";
import { readClaudeReviewMessages } from "./claude-transcript";
import { readCodexReviewMessages } from "./codex-transcript";
import type {
  NativeReviewMessage,
  NativeSessionSnapshot,
  NativeSessionUpdate,
  NativeTerminalEvent,
  NativeTerminalHandle,
  ObservedNativeSession,
  ReviewAgentHarness,
  SessionRef,
  UpdatePipe,
} from "./native-session";
import { readPiReviewMessages } from "./pi-transcript";
import { isMissingFileError } from "./transcript-json";

interface SessionState {
  binding: SessionRef;
  transcriptPath?: string;
  listeners: Set<() => void>;
}

interface LaunchState {
  accepted: boolean;
  resolveAccepted(session: SessionRef): void;
  rejectAccepted(error: Error): void;
  events: AsyncQueue<NativeTerminalEvent>;
  detached: boolean;
}

export class NativeSessionObserverRegistry {
  readonly #launches = new Map<string, LaunchState>();
  readonly #sessions = new Map<string, SessionState>();

  /** Wait for a terminal to report in on this session. Replaces any earlier pending launch for it. */
  beginLaunch(ref: SessionRef): NativeTerminalHandle {
    const key = sessionKey(ref);
    this.#detachLaunch(key);
    let resolveAccepted!: (session: SessionRef) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<SessionRef>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const events = new AsyncQueue<NativeTerminalEvent>();
    this.#launches.set(key, {
      accepted: false,
      resolveAccepted,
      rejectAccepted,
      events,
      detached: false,
    });
    return {
      accepted,
      events,
      detach: async () => {
        this.#detachLaunch(key);
      },
    };
  }

  /** A native hook fired for `ref`. Wakes observers whether or not a launch is pending. */
  acceptEvent(ref: SessionRef, payload: JsonValue): void {
    if (!isJsonObject(payload)) return;
    const key = sessionKey(ref);
    const launch = this.#launches.get(key);
    const event = nativeHookEvent(payload);
    if (event.sessionId && event.sessionId !== ref.sessionId) {
      if (launch) {
        launch.events.push({
          type: "session.mismatch",
          expectedSessionId: ref.sessionId,
          actualSessionId: event.sessionId,
        });
        if (!launch.accepted) {
          launch.rejectAccepted(
            new Error(
              `The terminal opened session "${event.sessionId}" instead of "${ref.sessionId}".`,
            ),
          );
        }
        this.#detachLaunch(key);
      }
      return;
    }
    if (launch && !launch.accepted) {
      launch.accepted = true;
      launch.resolveAccepted(ref);
    }
    const state = this.#session(ref);
    if (event.transcriptPath) state.transcriptPath = event.transcriptPath;
    wakeSession(state);
    if (event.completesTurn) {
      for (const delay of [250, 1_000]) {
        const timer = setTimeout(() => wakeSession(state), delay);
        timer.unref();
      }
    }
  }

  observerFailed(ref: SessionRef, cause: unknown): void {
    const key = sessionKey(ref);
    const launch = this.#launches.get(key);
    if (!launch) return;
    const message = errorMessage(cause);
    launch.events.push({ type: "observer.failed", error: message });
    if (!launch.accepted) launch.rejectAccepted(new Error(message));
    this.#detachLaunch(key);
  }

  observe(binding: SessionRef): ObservedNativeSession {
    return new RegistryObservedSession(this, this.#session(binding));
  }

  subscribe(state: SessionState, listener: () => void): () => void {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  async read(state: SessionState): Promise<NativeReviewMessage[]> {
    const { harness, sessionId } = state.binding;
    try {
      switch (harness) {
        case "claude-code":
          return await readClaudeReviewMessages({
            sessionId,
            transcriptPath: state.transcriptPath,
          });
        case "codex":
          return await readCodexReviewMessages({
            sessionId,
            transcriptPath: state.transcriptPath,
          });
        case "pi":
          return await readPiReviewMessages({
            sessionId,
            transcriptPath: state.transcriptPath,
          });
      }
    } catch (error) {
      // Session-start hooks can arrive before the native CLI creates its file.
      // Keep the observer alive; the next prompt or stop hook reads it again.
      if (isMissingTranscript(error)) return [];
      throw error;
    }
  }

  #session(binding: SessionRef): SessionState {
    const key = sessionKey(binding);
    let state = this.#sessions.get(key);
    if (!state) {
      state = { binding, listeners: new Set() };
      this.#sessions.set(key, state);
    }
    return state;
  }

  #detachLaunch(key: string): void {
    const launch = this.#launches.get(key);
    if (!launch) return;
    launch.detached = true;
    launch.events.close();
    this.#launches.delete(key);
  }
}

class RegistryObservedSession implements ObservedNativeSession {
  constructor(
    readonly registry: NativeSessionObserverRegistry,
    readonly state: SessionState,
  ) {}

  get ref(): SessionRef {
    return this.state.binding;
  }

  async updates(): Promise<
    UpdatePipe<NativeSessionSnapshot, NativeSessionUpdate>
  > {
    const wakes = new AsyncQueue<true>();
    const unsubscribe = this.registry.subscribe(this.state, () => {
      wakes.push(true);
    });
    try {
      const messages = await this.registry.read(this.state);
      const cursor = { count: messages.length };
      let closed = false;
      return {
        snapshot: { session: this.ref, messages },
        updates: {
          [Symbol.asyncIterator]: () =>
            this.#updates(wakes, cursor)[Symbol.asyncIterator](),
        },
        close: async () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          wakes.close();
        },
      };
    } catch (error) {
      unsubscribe();
      wakes.close();
      throw error;
    }
  }

  async *#updates(
    wakes: AsyncQueue<true>,
    cursor: { count: number },
  ): AsyncIterable<NativeSessionUpdate> {
    for await (const _wake of wakes) {
      const messages = await this.registry.read(this.state);
      for (const message of messages.slice(cursor.count)) {
        cursor.count += 1;
        yield { type: "message.updated", message };
      }
    }
  }
}

function sessionKey(ref: SessionRef): string {
  return `${ref.harness}:${ref.sessionId}`;
}

function isMissingTranscript(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return (
    isMissingFileError(cause) ||
    / has no (?:rollout|transcript) file\.$/u.test(cause.message)
  );
}

interface NativeHookEvent {
  sessionId?: string;
  transcriptPath?: string;
  completesTurn: boolean;
}

function nativeHookEvent(payload: JsonObject): NativeHookEvent {
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
  const eventName = firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload.event,
  )?.toLowerCase();
  const event: NativeHookEvent = {
    completesTurn:
      eventName === "stop" ||
      eventName === "sessionend" ||
      eventName === "agent_settled",
  };
  if (sessionId) event.sessionId = sessionId;
  if (transcriptPath) event.transcriptPath = transcriptPath;
  return event;
}

function wakeSession(state: SessionState): void {
  for (const listener of state.listeners) listener();
}

function firstString(...values: (JsonValue | undefined)[]): string | undefined {
  for (const value of values) {
    const text = jsonString(value);
    if (text) return text;
  }
  return undefined;
}
