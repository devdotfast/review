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
  SessionUpdate,
} from "./native-session";
import {
  ReviewCommandPath,
  reviewThreadEnvironment,
  tomlInline,
} from "./terminal-command";

const MATERIALIZE_TIMEOUT_MS = 60_000;

interface NativeToolEnvironment {
  [name: string]: string;
}

interface ThreadState {
  seenItems: Set<string>;
  subscribed: boolean;
  queue: AsyncQueue<SessionUpdate>;
  attached: boolean;
  activeTurn?: string;
  pending?: { id: string; notifications: CodexNotification[] };
  promptIds: Map<string, string>;
  accepted: Map<string, () => void>;
  interrupted: Set<() => void>;
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
    const pathValue = await this.#commandPath.resolve();
    const env: NativeToolEnvironment = {
      ...reviewThreadEnvironment(this.#desktop),
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
    };
    if (pathValue) env.PATH = pathValue;
    const config = { "shell_environment_policy.set": env };
    let threadId: string;
    if (!input.session) {
      threadId = await startThread(client, { cwd: input.cwd, config });
    } else if ("forkOf" in input.session) {
      threadId = await forkThread(client, {
        config,
        sourceThreadId: input.session.forkOf,
        cwd: input.cwd,
      });
    } else {
      threadId = input.session.resume;
      await client.request("thread/resume", { threadId, config });
      this.#thread(threadId).subscribed = true;
    }
    // Threads created on this connection already stream to it.
    const state = this.#thread(threadId);
    if (!input.session || "forkOf" in input.session) state.subscribed = true;
    if (input.prompt !== undefined) {
      // Review drives the turn; the TUI joins a running thread. Codex only
      // materializes a thread on its first user message, so wait for it.
      if (state.pending)
        throw new Error("Codex prompt submission is already pending.");
      state.pending = { id: input.prompt.id, notifications: [] };
      let result;
      try {
        result = await client.request("turn/start", {
          threadId,
          cwd: input.cwd,
          input: [{ type: "text", text: input.prompt.text, text_elements: [] }],
        });
      } catch (error) {
        state.pending = undefined;
        throw error;
      }
      const turnId = jsonString(jsonObject(jsonObject(result)?.turn)?.id);
      if (!turnId) throw new Error("Codex returned no submitted turn ID.");
      state.promptIds.set(turnId, input.prompt.id);
      state.activeTurn = turnId;
      const accepted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.accepted.delete(turnId);
          reject(new Error("Codex did not emit the submitted user message."));
        }, MATERIALIZE_TIMEOUT_MS);
        state.accepted.set(turnId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const pending = state.pending;
      state.pending = undefined;
      for (const notification of pending.notifications)
        this.#receive(notification);
      await accepted;
    }
    const url = await this.#host.url();
    const args = ["--remote", url];
    for (const [name, value] of Object.entries(env)) {
      args.push(
        "-c",
        `shell_environment_policy.set.${name}=${tomlInline(value)}`,
      );
    }
    args.push("resume", threadId);
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

  async updates(sessionId: string): Promise<{
    updates: AsyncIterable<SessionUpdate>;
    close(): Promise<void>;
  }> {
    const state = this.#threads.get(sessionId);
    if (!state)
      throw new Error("Launch the Codex session before observing it.");
    if (state.attached)
      throw new Error("Codex session already has an observer.");
    state.attached = true;
    return { updates: state.queue, close: async () => state.queue.close() };
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.#threads.get(sessionId);
    if (!state?.activeTurn) return;
    const turnId = state.activeTurn;
    const client = await this.#connect();
    let finish!: () => void;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.interrupted.delete(finish);
        reject(new Error("Codex did not confirm interruption."));
      }, MATERIALIZE_TIMEOUT_MS);
      finish = () => {
        clearTimeout(timer);
        resolve();
      };
      state.interrupted.add(finish);
    });
    try {
      await client.request("turn/interrupt", { threadId: sessionId, turnId });
    } catch (error) {
      state.interrupted.delete(finish);
      finish();
      throw error;
    }
    await done;
  }

  async close(): Promise<void> {
    for (const state of this.#threads.values()) state.queue.close();
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

  #receive(notification: CodexNotification): void {
    const threadId = jsonString(notification.params.threadId);
    if (threadId === undefined) return;
    const state = this.#threads.get(threadId);
    if (!state) return;
    if (state.pending) {
      state.pending.notifications.push(notification);
      return;
    }
    const turn = jsonObject(notification.params.turn);
    const turnId =
      notification.method === "turn/started" ||
      notification.method === "turn/completed"
        ? jsonString(turn?.id)
        : jsonString(notification.params.turnId);
    if (notification.method === "turn/started" && turnId) {
      state.activeTurn = turnId;
      state.queue.push({ type: "status.changed", status: "running" });
    }
    for (const message of projectCodexNotification(notification)) {
      if (state.seenItems.has(message.itemId)) continue;
      state.seenItems.add(message.itemId);
      if (message.role === "user" && turnId) {
        state.accepted.get(turnId)?.();
        state.accepted.delete(turnId);
      }
      const submitted =
        message.role === "user" && turnId
          ? state.promptIds.get(turnId)
          : undefined;
      if (submitted && turnId) state.promptIds.delete(turnId);
      state.queue.push({
        type: "message.updated",
        message: {
          id: submitted ?? message.itemId,
          role: message.role,
          body: message.body,
          createdAt: message.createdAt,
        },
      });
    }
    if (
      notification.method === "turn/completed" &&
      turnId === state.activeTurn
    ) {
      state.activeTurn = undefined;
      const status =
        turn?.status === "interrupted"
          ? "interrupted"
          : turn?.status === "failed"
            ? "failed"
            : "idle";
      state.queue.push({ type: "status.changed", status });
      for (const finish of state.interrupted) finish();
      state.interrupted.clear();
    }
  }

  #thread(threadId: string): ThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = {
        seenItems: new Set(),
        subscribed: false,
        queue: new AsyncQueue(),
        attached: false,
        promptIds: new Map(),
        accepted: new Map(),
        interrupted: new Set(),
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

/** The same projection applied to one live notification. */
export function projectCodexNotification(
  notification: CodexNotification,
): CodexMessage[] {
  const { method, params } = notification;
  if (method === "item/completed") {
    const user = userMessage(params.item, millisToIso(params.completedAtMs));
    return user ? [user] : [];
  }
  const turn = jsonObject(params.turn);
  if (method === "turn/completed" && turn) {
    const items = jsonArray(turn.items);
    if (turn.status !== "completed" || !items) return [];
    const final = finalAgentMessage(items, secondsToIso(turn.completedAt));
    return final ? [final] : [];
  }
  return [];
}

function userMessage(
  item: JsonValue | undefined,
  createdAt: string,
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
  return { id: itemId, role: "user", body, createdAt, itemId };
}

function finalAgentMessage(
  items: readonly JsonValue[],
  createdAt: string,
): CodexMessage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = jsonObject(items[index]);
    const itemId = jsonString(item?.id);
    const text = jsonString(item?.text)?.trim();
    if (item?.type === "agentMessage" && itemId !== undefined && text) {
      return { id: itemId, role: "assistant", body: text, createdAt, itemId };
    }
  }
  return undefined;
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
