import {
  type JsonValue,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import {
  type CodexAppServerClient,
  CodexAppServerHost,
  type CodexNotification,
  forkThread,
  startThread,
} from "./codex-app-server";
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
import { ReviewCommandPath, reviewThreadEnvironment } from "./terminal-command";

const MATERIALIZE_TIMEOUT_MS = 60_000;

interface ThreadState {
  /** Messages seen so far, in order, with the item ids they came from. */
  messages: CodexMessage[];
  seenItems: Set<string>;
  /** The shared server streams this thread's events to our connection. */
  subscribed: boolean;
  /** thread/read has seeded `messages` once. */
  loaded: boolean;
  subscribers: Set<AsyncQueue<SessionUpdate>>;
}

/** Something that hands out the shared app-server connection. */
export interface CodexHost {
  url(): Promise<string>;
  client(): Promise<CodexAppServerClient>;
  close(): Promise<void>;
}

/**
 * Codex has a real app-server. Review owns one shared `codex app-server
 * --listen` process; threads are created and driven through it, its
 * notifications are the session's updates, and the native TUI attaches to
 * the same server with `codex --remote`.
 */
export class CodexAgentServer implements AgentServer {
  readonly harness = "codex" as const;
  readonly #host: CodexHost;
  readonly #threadEnvironment: Record<string, string>;
  readonly #commandPath: ReviewCommandPath;
  readonly #threads = new Map<string, ThreadState>();
  #listening: CodexAppServerClient | undefined;

  constructor(options: AgentServerOptions, host: CodexHost) {
    this.#host = host;
    this.#threadEnvironment = reviewThreadEnvironment(options.desktopEndpoint);
    this.#commandPath = new ReviewCommandPath(options);
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; command: NativeTerminalCommand }> {
    const client = await this.#connect();
    const pathValue = await this.#commandPath.resolve();
    const reviewHome = devReviewHome();
    const env: NativeTerminalCommand["env"] = {
      ...this.#threadEnvironment,
      [DEV_REVIEW_HOME_ENV]: reviewHome,
    };
    if (pathValue) env.PATH = pathValue;
    // Tools execute in app-server, not in the remote TUI. Set this before
    // the first turn, including when forking or resuming an existing thread.
    const config = { "shell_environment_policy.set": env };
    let threadId: string;
    if (!input.session) {
      threadId = await startThread(client, { cwd: input.cwd, config });
    } else if ("forkOf" in input.session) {
      threadId = await forkThread(client, {
        sourceThreadId: input.session.forkOf,
        cwd: input.cwd,
        config,
      });
    } else {
      threadId = input.session.resume;
      await this.#subscribe(client, threadId, config);
    }
    // Threads created on this connection already stream to it.
    const state = this.#thread(threadId);
    if (!input.session || "forkOf" in input.session) state.subscribed = true;
    if (input.prompt !== undefined) {
      await input.prompt.prepared(threadId);
      const queue = new AsyncQueue<SessionUpdate>();
      state.subscribers.add(queue);
      const timer = setTimeout(() => queue.close(), MATERIALIZE_TIMEOUT_MS);
      try {
        const result = await client.request("turn/start", {
          threadId,
          cwd: input.cwd,
          input: [{ type: "text", text: input.prompt.text, text_elements: [] }],
        });
        const turnId = jsonString(jsonObject(jsonObject(result)?.turn)?.id);
        if (!turnId) throw new Error("Codex returned a turn without an ID.");
        let accepted = false;
        for await (const update of queue) {
          const message = state.messages.find(
            (item) => item.id === update.message.id,
          );
          if (message?.role !== "user" || message.turnId !== turnId) continue;
          await input.prompt.accepted(threadId, message.id);
          accepted = true;
          break;
        }
        if (!accepted)
          throw new Error("Codex did not report the submitted user message.");
      } finally {
        clearTimeout(timer);
        state.subscribers.delete(queue);
        queue.close();
      }
    }
    const url = await this.#host.url();
    const args = ["--remote", url, "resume", threadId];
    return {
      sessionId: threadId,
      command: {
        cwd: input.cwd,
        executable: "codex",
        args,
        env,
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const client = await this.#connect();
    const state = this.#thread(sessionId);
    if (!state.subscribed) await this.#subscribe(client, sessionId, {});
    if (!state.loaded) {
      const history = await this.#readThread(client, sessionId);
      const historyIds = new Set(history.map((message) => message.id));
      // Live notifications can arrive before thread/read, including while
      // that request is pending. History owns conversation order; retain
      // only live items not yet included in that snapshot as its tail.
      state.messages = [
        ...history,
        ...state.messages.filter((message) => !historyIds.has(message.id)),
      ];
      state.seenItems = new Set(state.messages.map((message) => message.id));
      state.loaded = true;
    }
    const queue = new AsyncQueue<SessionUpdate>();
    state.subscribers.add(queue);
    return {
      snapshot: { sessionId, messages: [...state.messages] },
      updates: queue,
      close: async () => {
        state.subscribers.delete(queue);
        queue.close();
      },
    };
  }

  async close(): Promise<void> {
    for (const state of this.#threads.values()) {
      for (const queue of state.subscribers) queue.close();
      state.subscribers.clear();
    }
    await this.#host.close();
  }

  async #connect(): Promise<CodexAppServerClient> {
    const client = await this.#host.client();
    if (this.#listening !== client) {
      // A fresh connection knows nothing about earlier subscriptions.
      for (const state of this.#threads.values()) state.subscribed = false;
      client.onNotification((notification) => this.#receive(notification));
      this.#listening = client;
    }
    return client;
  }

  /** Rejoin a thread this connection did not create, if it exists on disk. */
  async #subscribe(
    client: CodexAppServerClient,
    threadId: string,
    config: Record<string, JsonValue>,
  ): Promise<void> {
    const state = this.#thread(threadId);
    try {
      await client.request("thread/resume", {
        threadId,
        config,
      });
      state.subscribed = true;
    } catch (error) {
      if (!isUnmaterialized(error)) throw error;
    }
  }

  async #readThread(
    client: CodexAppServerClient,
    threadId: string,
  ): Promise<CodexMessage[]> {
    let result: JsonValue | undefined;
    try {
      result = await client.request("thread/read", {
        threadId,
        includeTurns: true,
      });
    } catch (error) {
      if (isUnmaterialized(error)) return [];
      throw error;
    }
    const thread = jsonObject(jsonObject(result)?.thread);
    if (!thread) {
      throw new Error("Codex returned an invalid thread.");
    }
    return projectCodexTurns(thread.turns);
  }

  #receive(notification: CodexNotification): void {
    const threadId = jsonString(notification.params.threadId);
    if (threadId === undefined) return;
    const state = this.#threads.get(threadId);
    if (!state) return;
    for (const message of projectCodexNotification(notification)) {
      this.#append(state, message);
    }
  }

  #append(state: ThreadState, message: CodexMessage): void {
    if (state.seenItems.has(message.id)) return;
    state.seenItems.add(message.id);
    state.messages.push(message);
    for (const queue of state.subscribers) {
      queue.push({ type: "message.updated", message });
    }
  }

  #thread(threadId: string): ThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = {
        messages: [],
        seenItems: new Set(),
        subscribed: false,
        loaded: false,
        subscribers: new Set(),
      };
      this.#threads.set(threadId, state);
    }
    return state;
  }
}

export interface CodexMessage extends NativeReviewMessage {
  /** Correlates the submitted prompt with turn/start, not its body text. */
  turnId: string;
}

/** Review-visible messages from `thread/read` turns: every user message, and the final agent message of each completed turn. */
export function projectCodexTurns(
  turns: JsonValue | undefined,
): CodexMessage[] {
  const list = jsonArray(turns);
  if (!list) return [];
  const messages: CodexMessage[] = [];
  for (const entry of list) {
    const turn = jsonObject(entry);
    const items = jsonArray(turn?.items);
    if (!turn || !items) continue;
    const startedAt = secondsToIso(turn.startedAt);
    const completedAt = secondsToIso(turn.completedAt);
    for (const item of items) {
      const user = userMessage(item, startedAt, jsonString(turn.id));
      if (user) messages.push(user);
    }
    if (turn.status === "completed") {
      const final = finalAgentMessage(items, completedAt, jsonString(turn.id));
      if (final) messages.push(final);
    }
  }
  return messages;
}

/** The same projection applied to one live notification. */
export function projectCodexNotification(
  notification: CodexNotification,
): CodexMessage[] {
  const { method, params } = notification;
  if (method === "item/completed") {
    const user = userMessage(
      params.item,
      millisToIso(params.completedAtMs),
      jsonString(params.turnId),
    );
    return user ? [user] : [];
  }
  const turn = jsonObject(params.turn);
  if (method === "turn/completed" && turn) {
    const items = jsonArray(turn.items);
    if (turn.status !== "completed" || !items) return [];
    const final = finalAgentMessage(
      items,
      secondsToIso(turn.completedAt),
      jsonString(turn.id),
    );
    return final ? [final] : [];
  }
  return [];
}

function userMessage(
  item: JsonValue | undefined,
  createdAt: string,
  turnId: string | undefined,
): CodexMessage | undefined {
  const record = jsonObject(item);
  const itemId = jsonString(record?.id);
  const content = jsonArray(record?.content);
  if (
    !record ||
    record.type !== "userMessage" ||
    itemId === undefined ||
    !content
  ) {
    return undefined;
  }
  const body = content
    .flatMap((entry) => {
      const part = jsonObject(entry);
      const text = jsonString(part?.text);
      return part?.type === "text" && text !== undefined ? [text] : [];
    })
    .join("\n")
    .trim();
  if (!body) return undefined;
  if (!turnId) throw new Error("Codex user message has no turn ID.");
  return { id: itemId, turnId, role: "user", body, createdAt };
}

function finalAgentMessage(
  items: readonly JsonValue[],
  createdAt: string,
  turnId: string | undefined,
): CodexMessage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = jsonObject(items[index]);
    const itemId = jsonString(item?.id);
    const text = jsonString(item?.text)?.trim();
    if (item?.type === "agentMessage" && itemId !== undefined && text) {
      if (!turnId) throw new Error("Codex assistant message has no turn ID.");
      return { id: itemId, turnId, role: "assistant", body: text, createdAt };
    }
  }
  return undefined;
}

function isUnmaterialized(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (/no rollout found/u.test(cause.message) ||
      /not materialized/u.test(cause.message))
  );
}

function secondsToIso(value: JsonValue | undefined): string {
  const seconds = jsonNumber(value);
  return seconds === undefined
    ? new Date(0).toISOString()
    : new Date(seconds * 1000).toISOString();
}

function millisToIso(value: JsonValue | undefined): string {
  const millis = jsonNumber(value);
  return millis === undefined
    ? new Date(0).toISOString()
    : new Date(millis).toISOString();
}

export function server(
  options: AgentServerOptions & { host?: CodexHost },
): AgentServer {
  return new CodexAgentServer(
    options,
    options.host ?? new CodexAppServerHost(),
  );
}
