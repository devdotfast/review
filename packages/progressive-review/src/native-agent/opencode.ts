import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
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
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** Something that hands out the shared `opencode serve` endpoint. */
export interface OpencodeHost {
  /** Base URL plus the server password, once the server is healthy. */
  endpoint(): Promise<{ baseUrl: string; password: string }>;
  close(): Promise<void>;
}

interface SessionState {
  /** Directory the session runs in; every request is scoped to it. */
  directory: string;
  messages: NativeReviewMessage[];
  seen: Set<string>;
  loaded: boolean;
  subscribers: Set<AsyncQueue<SessionUpdate>>;
}

/**
 * OpenCode is server-first: the TUI is a client of `opencode serve`. Review
 * owns one such server; sessions are created and prompted through its HTTP
 * API, its event stream is the session's updates, and the native TUI
 * attaches to the same server with `opencode attach`.
 */
export class OpencodeAgentServer implements AgentServer {
  readonly harness = "opencode" as const;
  readonly #host: OpencodeHost;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();
  #events: { abort: AbortController; baseUrl: string } | undefined;

  constructor(options: AgentServerOptions, host: OpencodeHost) {
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
    const client = await this.#client();
    let sessionId: string;
    if (!input.session) {
      sessionId = sessionIdOf(
        await client.json("POST", "/session", input.cwd, {
          title: "Review question",
        }),
      );
    } else if ("forkOf" in input.session) {
      sessionId = sessionIdOf(
        await client.json(
          "POST",
          `/session/${encodeURIComponent(input.session.forkOf)}/fork`,
          input.cwd,
          {},
        ),
      );
    } else {
      sessionId = input.session.resume;
    }
    const state = this.#session(sessionId, input.cwd);
    if (input.prompt !== undefined) {
      // Review drives the turn; the TUI attaches to a session already at work.
      await client.json(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        input.cwd,
        { parts: [{ type: "text", text: input.prompt }] },
      );
    }
    void state;
    const pathValue = await this.#commandPath.resolve();
    return {
      sessionId,
      command: {
        cwd: input.cwd,
        executable: "opencode",
        args: [
          "attach",
          client.baseUrl,
          "--session",
          sessionId,
          "--dir",
          input.cwd,
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: client.password,
          [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/opencode/${encodeURIComponent(sessionId)}/thread`,
          [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
          [DEV_REVIEW_HOME_ENV]: devReviewHome(),
          ...(pathValue ? { PATH: pathValue } : {}),
        },
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const client = await this.#client();
    const state = this.#session(sessionId);
    if (!state.loaded) {
      await this.#refresh(client, sessionId, state);
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
    for (const state of this.#sessions.values()) {
      for (const queue of state.subscribers) queue.close();
      state.subscribers.clear();
    }
    this.#events?.abort.abort();
    this.#events = undefined;
    await this.#host.close();
  }

  async #client(): Promise<OpencodeClient> {
    const { baseUrl, password } = await this.#host.endpoint();
    const client = new OpencodeClient(baseUrl, password);
    if (this.#events?.baseUrl !== baseUrl) {
      this.#events?.abort.abort();
      const abort = new AbortController();
      this.#events = { abort, baseUrl };
      void this.#follow(client, abort.signal);
    }
    return client;
  }

  /** The event stream names sessions that changed; each is re-read and diffed. */
  async #follow(client: OpencodeClient, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of client.events(signal)) {
        const sessionId = eventSessionId(event);
        if (!sessionId) continue;
        const state = this.#sessions.get(sessionId);
        if (!state || !state.loaded) continue;
        await this.#refresh(client, sessionId, state);
      }
    } catch (error) {
      if (signal.aborted) return;
      // The stream dropped; the next request reconnects it.
      if (this.#events?.abort.signal === signal) this.#events = undefined;
      console.error("OpenCode event stream failed:", error);
    }
  }

  async #refresh(
    client: OpencodeClient,
    sessionId: string,
    state: SessionState,
  ): Promise<void> {
    const messages = projectOpencodeMessages(
      await client.json(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        state.directory,
      ),
    );
    for (const message of messages) {
      if (state.seen.has(message.messageId)) continue;
      state.seen.add(message.messageId);
      const { messageId: _messageId, ...review } = message;
      state.messages.push(review);
      for (const queue of state.subscribers) {
        queue.push({ type: "message.updated", message: review });
      }
    }
  }

  #session(sessionId: string, directory?: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        directory: directory ?? "",
        messages: [],
        seen: new Set(),
        loaded: false,
        subscribers: new Set(),
      };
      this.#sessions.set(sessionId, state);
    } else if (directory) {
      state.directory = directory;
    }
    return state;
  }
}

export interface OpencodeMessage extends NativeReviewMessage {
  messageId: string;
}

/** Every user message, and every assistant message that completed without error. */
export function projectOpencodeMessages(value: unknown): OpencodeMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("OpenCode returned an invalid session message list.");
  }
  const messages: OpencodeMessage[] = [];
  for (const entry of value) {
    if (!isJsonRecord(entry) || !isJsonRecord(entry.info)) continue;
    const info = entry.info;
    if (typeof info.id !== "string" || !isJsonRecord(info.time)) continue;
    const body = (Array.isArray(entry.parts) ? entry.parts : [])
      .flatMap((part) =>
        isJsonRecord(part) &&
        part.type === "text" &&
        part.ignored !== true &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("\n")
      .trim();
    if (!body) continue;
    if (info.role === "user") {
      messages.push({
        role: "user",
        body,
        createdAt: millisToIso(info.time.created),
        messageId: info.id,
      });
    } else if (
      info.role === "assistant" &&
      typeof info.time.completed === "number" &&
      info.error === undefined
    ) {
      messages.push({
        role: "assistant",
        body,
        createdAt: millisToIso(info.time.completed),
        messageId: info.id,
      });
    }
  }
  return messages;
}

function eventSessionId(event: unknown): string | undefined {
  if (!isJsonRecord(event) || !isJsonRecord(event.properties)) return undefined;
  const properties = event.properties;
  if (
    event.type === "message.updated" &&
    isJsonRecord(properties.info) &&
    typeof properties.info.sessionID === "string"
  ) {
    return properties.info.sessionID;
  }
  if (
    (event.type === "session.idle" || event.type === "session.updated") &&
    typeof properties.sessionID === "string"
  ) {
    return properties.sessionID;
  }
  if (
    event.type === "session.updated" &&
    isJsonRecord(properties.info) &&
    typeof properties.info.id === "string"
  ) {
    return properties.info.id;
  }
  return undefined;
}

function sessionIdOf(value: unknown): string {
  if (!isJsonRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("OpenCode returned an invalid session.");
  }
  return value.id;
}

function millisToIso(value: unknown): string {
  return typeof value === "number"
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

/** Authenticated HTTP client for one `opencode serve`. */
export class OpencodeClient {
  readonly #authorization: string;

  constructor(
    readonly baseUrl: string,
    readonly password: string,
  ) {
    this.#authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  async json(
    method: "GET" | "POST",
    pathname: string,
    directory: string | undefined,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(pathname, this.baseUrl);
    if (directory) url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.#authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenCode ${method} ${pathname} failed (${response.status}): ${text}`,
      );
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  /** Parsed `/global/event` server-sent events until the signal aborts. */
  async *events(signal: AbortSignal): AsyncGenerator<unknown> {
    const response = await fetch(new URL("/global/event", this.baseUrl), {
      headers: {
        authorization: this.#authorization,
        accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode event stream failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    // Cancel the body on abort so the stream ends cleanly instead of erroring
    // when the socket closes later.
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = raw
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data) as unknown;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  }
}

/** Owns one `opencode serve` process on a reserved loopback port. */
export class OpencodeServeHost implements OpencodeHost {
  #started:
    | Promise<{ child: ChildProcess; baseUrl: string; password: string }>
    | undefined;

  async endpoint(): Promise<{ baseUrl: string; password: string }> {
    const { baseUrl, password } = await this.#start();
    return { baseUrl, password };
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    const started = this.#started;
    this.#started = undefined;
    const { child } = await started;
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  #start(): Promise<{
    child: ChildProcess;
    baseUrl: string;
    password: string;
  }> {
    if (this.#started) return this.#started;
    const started = (async () => {
      const port = await reservePort();
      const password = randomBytes(24).toString("base64url");
      const baseUrl = `http://${HOST}:${port}`;
      const child = spawn(
        "opencode",
        ["serve", "--hostname", HOST, "--port", String(port)],
        {
          cwd: "/",
          env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      child.once("exit", () => {
        this.#started = undefined;
      });
      const client = new OpencodeClient(baseUrl, password);
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (child.exitCode === null) {
        try {
          const health = await client.json("GET", "/global/health", undefined);
          if (isJsonRecord(health) && health.healthy === true) {
            return { child, baseUrl, password };
          }
        } catch {
          // Not up yet.
        }
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (child.exitCode === null) child.kill("SIGTERM");
      throw new Error(
        `OpenCode server did not become ready.\n\n${stderr.trim()}`,
      );
    })();
    this.#started = started;
    return started;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port for OpenCode.");
  }
  return address.port;
}

/** Fork a session on a throwaway server. Used by the CLI to freeze a review's source. */
export async function forkOpencodeSession(input: {
  sourceSessionId: string;
  cwd: string;
}): Promise<string> {
  const host = new OpencodeServeHost();
  try {
    const { baseUrl, password } = await host.endpoint();
    const client = new OpencodeClient(baseUrl, password);
    return sessionIdOf(
      await client.json(
        "POST",
        `/session/${encodeURIComponent(input.sourceSessionId)}/fork`,
        input.cwd,
        {},
      ),
    );
  } finally {
    await host.close();
  }
}

const REPLY_TIMEOUT_MS = 10 * 60_000;
const REPLY_POLL_MS = 1_000;

/**
 * Create a session, prompt it, and return once the assistant has replied.
 * Runs on a throwaway server; used for the tutorial source. The prompt is
 * submitted asynchronously and the session polled, because one model turn
 * can outlast any single request timeout.
 */
export async function createOpencodeSession(input: {
  cwd: string;
  prompt: string;
  title: string;
  signal?: AbortSignal;
}): Promise<string> {
  const host = new OpencodeServeHost();
  try {
    const { baseUrl, password } = await host.endpoint();
    const client = new OpencodeClient(baseUrl, password);
    const sessionId = sessionIdOf(
      await client.json("POST", "/session", input.cwd, { title: input.title }),
    );
    await client.json(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      input.cwd,
      { parts: [{ type: "text", text: input.prompt }] },
    );
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
      if (input.signal?.aborted) {
        throw new Error("OpenCode session creation was canceled.");
      }
      const messages = await client.json(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        input.cwd,
      );
      const failure = assistantFailure(messages);
      if (failure) throw new Error(`OpenCode could not reply: ${failure}`);
      if (
        projectOpencodeMessages(messages).some((m) => m.role === "assistant")
      ) {
        return sessionId;
      }
      if (Date.now() > deadline) {
        throw new Error("OpenCode did not reply within the time limit.");
      }
      await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
    }
  } finally {
    await host.close();
  }
}

/** The first assistant message that ended in an error, as a short description. */
function assistantFailure(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const entry of messages) {
    if (!isJsonRecord(entry) || !isJsonRecord(entry.info)) continue;
    const info = entry.info;
    if (info.role !== "assistant" || !isJsonRecord(info.error)) continue;
    const name =
      typeof info.error.name === "string" ? info.error.name : "error";
    const data = isJsonRecord(info.error.data) ? info.error.data : {};
    const message = typeof data.message === "string" ? `: ${data.message}` : "";
    return `${name}${message}`;
  }
  return undefined;
}

export function server(
  options: AgentServerOptions & { host?: OpencodeHost },
): AgentServer {
  return new OpencodeAgentServer(
    options,
    options.host ?? new OpencodeServeHost(),
  );
}
