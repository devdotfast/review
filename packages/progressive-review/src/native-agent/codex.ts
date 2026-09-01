import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import {
  type CodexAppServerClient,
  CodexAppServerHost,
  type CodexNotification,
  forkThread,
  startThread,
} from "./codex-app-server";
import type { NativeTerminalCommand } from "./harness";
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
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
  tomlInline,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

const MATERIALIZE_TIMEOUT_MS = 60_000;

interface ThreadState {
  /** Messages seen so far, in order, with the item ids they came from. */
  messages: NativeReviewMessage[];
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
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #threads = new Map<string, ThreadState>();
  #listening: CodexAppServerClient | undefined;

  constructor(options: AgentServerOptions, host: CodexHost) {
    this.#host = host;
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; command: NativeTerminalCommand }> {
    const client = await this.#connect();
    let threadId: string;
    if (!input.session) {
      threadId = await startThread(client, { cwd: input.cwd });
    } else if ("forkOf" in input.session) {
      threadId = await forkThread(client, {
        sourceThreadId: input.session.forkOf,
        cwd: input.cwd,
      });
    } else {
      threadId = input.session.resume;
      await this.#subscribe(client, threadId);
    }
    // Threads created on this connection already stream to it.
    const state = this.#thread(threadId);
    if (!input.session || "forkOf" in input.session) state.subscribed = true;
    if (input.prompt !== undefined) {
      // Review drives the turn; the TUI joins a running thread. Codex only
      // materializes a thread on its first user message, so wait for it.
      const materialized = this.#materialized(threadId);
      await client.request("turn/start", {
        threadId,
        cwd: input.cwd,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
      });
      await materialized;
    }
    const url = await this.#host.url();
    const pathValue = await this.#commandPath.resolve();
    const reviewHome = devReviewHome();
    const args = ["--remote", url];
    if (pathValue) {
      args.push(
        "-c",
        `shell_environment_policy.set.PATH=${tomlInline(pathValue)}`,
      );
    }
    args.push(
      "-c",
      `shell_environment_policy.set.${DEV_REVIEW_HOME_ENV}=${tomlInline(reviewHome)}`,
      "resume",
      threadId,
    );
    return {
      sessionId: threadId,
      command: {
        cwd: input.cwd,
        executable: "codex",
        args,
        env: {
          [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/codex/${encodeURIComponent(threadId)}/thread`,
          [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
          [DEV_REVIEW_HOME_ENV]: reviewHome,
          ...(pathValue ? { PATH: pathValue } : {}),
        },
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const client = await this.#connect();
    const state = this.#thread(sessionId);
    if (!state.subscribed) await this.#subscribe(client, sessionId);
    if (!state.loaded) {
      for (const message of await this.#readThread(client, sessionId)) {
        this.#append(state, message);
      }
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
  ): Promise<void> {
    const state = this.#thread(threadId);
    try {
      await client.request("thread/resume", { threadId });
      state.subscribed = true;
    } catch (error) {
      if (!isUnmaterialized(error)) throw error;
    }
  }

  async #readThread(
    client: CodexAppServerClient,
    threadId: string,
  ): Promise<CodexMessage[]> {
    let result: unknown;
    try {
      result = await client.request("thread/read", {
        threadId,
        includeTurns: true,
      });
    } catch (error) {
      if (isUnmaterialized(error)) return [];
      throw error;
    }
    if (!isJsonRecord(result) || !isJsonRecord(result.thread)) {
      throw new Error("Codex returned an invalid thread.");
    }
    return projectCodexTurns(result.thread.turns);
  }

  #materialized(threadId: string): Promise<void> {
    const state = this.#thread(threadId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.subscribers.delete(queue);
        reject(
          new Error(`Codex did not accept the prompt for thread ${threadId}.`),
        );
      }, MATERIALIZE_TIMEOUT_MS);
      timer.unref();
      const queue = new AsyncQueue<SessionUpdate>();
      state.subscribers.add(queue);
      void (async () => {
        for await (const update of queue) {
          if (update.message.role === "user") break;
        }
        clearTimeout(timer);
        state.subscribers.delete(queue);
        resolve();
      })();
    });
  }

  #receive(notification: CodexNotification): void {
    const threadId = notification.params.threadId;
    if (typeof threadId !== "string") return;
    const state = this.#threads.get(threadId);
    if (!state) return;
    for (const message of projectCodexNotification(notification)) {
      this.#append(state, message);
    }
  }

  #append(state: ThreadState, message: CodexMessage): void {
    if (state.seenItems.has(message.itemId)) return;
    state.seenItems.add(message.itemId);
    const { itemId: _itemId, ...review } = message;
    state.messages.push(review);
    for (const queue of state.subscribers) {
      queue.push({ type: "message.updated", message: review });
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
  /** The app-server item this message came from; dedupes read vs stream. */
  itemId: string;
}

/** Review-visible messages from `thread/read` turns: every user message, and the final agent message of each completed turn. */
export function projectCodexTurns(turns: unknown): CodexMessage[] {
  if (!Array.isArray(turns)) return [];
  const messages: CodexMessage[] = [];
  for (const turn of turns) {
    if (!isJsonRecord(turn) || !Array.isArray(turn.items)) continue;
    const startedAt = secondsToIso(turn.startedAt);
    const completedAt = secondsToIso(turn.completedAt);
    for (const item of turn.items) {
      const user = userMessage(item, startedAt);
      if (user) messages.push(user);
    }
    if (turn.status === "completed") {
      const final = finalAgentMessage(turn.items, completedAt);
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
    const user = userMessage(params.item, millisToIso(params.completedAtMs));
    return user ? [user] : [];
  }
  if (method === "turn/completed" && isJsonRecord(params.turn)) {
    const turn = params.turn;
    if (turn.status !== "completed" || !Array.isArray(turn.items)) return [];
    const final = finalAgentMessage(turn.items, secondsToIso(turn.completedAt));
    return final ? [final] : [];
  }
  return [];
}

function userMessage(
  item: unknown,
  createdAt: string,
): CodexMessage | undefined {
  if (
    !isJsonRecord(item) ||
    item.type !== "userMessage" ||
    typeof item.id !== "string" ||
    !Array.isArray(item.content)
  ) {
    return undefined;
  }
  const body = item.content
    .flatMap((part) =>
      isJsonRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
  if (!body) return undefined;
  return { role: "user", body, createdAt, itemId: item.id };
}

function finalAgentMessage(
  items: unknown[],
  createdAt: string,
): CodexMessage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      isJsonRecord(item) &&
      item.type === "agentMessage" &&
      typeof item.id === "string" &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      return {
        role: "assistant",
        body: item.text.trim(),
        createdAt,
        itemId: item.id,
      };
    }
  }
  return undefined;
}

function isUnmaterialized(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/no rollout found/u.test(error.message) ||
      /not materialized/u.test(error.message))
  );
}

function secondsToIso(value: unknown): string {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : new Date(0).toISOString();
}

function millisToIso(value: unknown): string {
  return typeof value === "number"
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

export function server(
  options: AgentServerOptions & { host?: CodexHost },
): AgentServer {
  return new CodexAgentServer(
    options,
    options.host ?? new CodexAppServerHost(),
  );
}
