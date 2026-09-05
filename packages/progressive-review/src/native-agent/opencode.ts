import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

import {
  type JsonValue,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

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
    // OpenCode sessions belong to a project keyed by directory. A fork stays
    // in its source's project, so the session's own directory scopes every
    // request and the terminal, not the review's checkout.
    let session: { id: string; directory: string };
    if (!input.session) {
      session = sessionOf(
        await client.json("POST", "/session", input.cwd, {
          title: "Review question",
        }),
      );
    } else if ("forkOf" in input.session) {
      const source = await client.session(input.session.forkOf);
      session = sessionOf(
        await client.json(
          "POST",
          `/session/${encodeURIComponent(source.id)}/fork`,
          source.directory,
          {},
        ),
      );
    } else {
      session = await client.session(input.session.resume);
    }
    const sessionId = session.id;
    this.#session(sessionId, session.directory);
    if (input.prompt !== undefined) {
      // Review drives the turn; the TUI attaches to a session already at work.
      await client.json(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        session.directory,
        { parts: [{ type: "text", text: input.prompt }] },
      );
    }
    const pathValue = await this.#commandPath.resolve();
    const env: NativeTerminalCommand["env"] = {
      OPENCODE_SERVER_PASSWORD: client.password,
      [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/opencode/${encodeURIComponent(sessionId)}/thread`,
      [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
    };
    if (pathValue) env.PATH = pathValue;
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
          session.directory,
        ],
        env,
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const client = await this.#client();
    const state = this.#session(sessionId);
    if (!state.directory) {
      state.directory = (await client.session(sessionId)).directory;
    }
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
export function projectOpencodeMessages(
  value: JsonValue | undefined,
): OpencodeMessage[] {
  const list = jsonArray(value);
  if (!list) {
    throw new Error("OpenCode returned an invalid session message list.");
  }
  const messages: OpencodeMessage[] = [];
  for (const entry of list) {
    const record = jsonObject(entry);
    const info = jsonObject(record?.info);
    const time = jsonObject(info?.time);
    const messageId = jsonString(info?.id);
    if (!record || !info || !time || messageId === undefined) continue;
    const body = (jsonArray(record.parts) ?? [])
      .flatMap((item) => {
        const part = jsonObject(item);
        const text = jsonString(part?.text);
        return part?.type === "text" &&
          part.ignored !== true &&
          text !== undefined
          ? [text]
          : [];
      })
      .join("\n")
      .trim();
    if (!body) continue;
    if (info.role === "user") {
      messages.push({
        role: "user",
        body,
        createdAt: millisToIso(time.created),
        messageId,
      });
      continue;
    }
    const completed = jsonNumber(time.completed);
    if (
      info.role === "assistant" &&
      completed !== undefined &&
      info.error === undefined
    ) {
      messages.push({
        role: "assistant",
        body,
        createdAt: millisToIso(completed),
        messageId,
      });
    }
  }
  return messages;
}

function eventSessionId(event: JsonValue): string | undefined {
  const record = jsonObject(event);
  const properties = jsonObject(record?.properties);
  if (!record || !properties) return undefined;
  const info = jsonObject(properties.info);
  if (record.type === "message.updated") return jsonString(info?.sessionID);
  if (record.type === "session.idle") return jsonString(properties.sessionID);
  if (record.type === "session.updated") {
    return jsonString(properties.sessionID) ?? jsonString(info?.id);
  }
  return undefined;
}

interface OpencodeSession {
  id: string;
  directory: string;
}

function sessionOf(value: JsonValue | undefined): OpencodeSession {
  const record = jsonObject(value);
  const id = jsonString(record?.id);
  const directory = jsonString(record?.directory);
  if (!id || directory === undefined) {
    throw new Error("OpenCode returned an invalid session.");
  }
  return { id, directory };
}

function millisToIso(value: JsonValue | undefined): string {
  const millis = jsonNumber(value);
  return millis === undefined
    ? new Date(0).toISOString()
    : new Date(millis).toISOString();
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
    body?: JsonValue,
  ): Promise<JsonValue | undefined> {
    const response = await this.#fetch(method, pathname, directory, body);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenCode ${method} ${pathname} failed (${response.status}): ${text}`,
      );
    }
    return text ? parseJsonText(text) : undefined;
  }

  #fetch(
    method: "GET" | "POST",
    pathname: string,
    directory: string | undefined,
    body?: JsonValue,
  ): Promise<Response> {
    const url = new URL(pathname, this.baseUrl);
    if (directory) url.searchParams.set("directory", directory);
    const headers = new Headers({ authorization: this.#authorization });
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    return fetch(url, init);
  }

  /**
   * Find a session by id. Sessions are stored per project, and a lookup is
   * scoped to one directory, so every project the server knows is tried.
   */
  async session(id: string): Promise<OpencodeSession> {
    const projects = jsonArray(await this.json("GET", "/project", undefined));
    if (!projects) {
      throw new Error("OpenCode returned an invalid project list.");
    }
    const worktrees = projects.flatMap((project) => {
      const worktree = jsonString(jsonObject(project)?.worktree);
      return worktree === undefined ? [] : [worktree];
    });
    for (const worktree of new Set(worktrees)) {
      const response = await this.#fetch(
        "GET",
        `/session/${encodeURIComponent(id)}`,
        worktree,
      );
      if (response.status === 404) continue;
      if (!response.ok) {
        throw new Error(
          `OpenCode GET /session/${id} failed (${response.status}): ${await response.text()}`,
        );
      }
      return sessionOf(parseJsonText(await response.text()));
    }
    throw new Error(`OpenCode has no session ${id} in any known project.`);
  }

  /** Parsed `/global/event` server-sent events until the signal aborts. */
  async *events(signal: AbortSignal): AsyncGenerator<JsonValue> {
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
          if (data) yield parseJsonText(data);
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
          if (jsonObject(health)?.healthy === true) {
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
  if (!address) {
    throw new Error("Could not reserve a loopback port for OpenCode.");
  }
  // SAFETY: a TCP listener bound to a port reports an AddressInfo, never a pipe path.
  return (address as AddressInfo).port;
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
    // The fork lands in the source session's project, whatever the review's
    // checkout is; the terminal later attaches with that directory.
    const source = await client.session(input.sourceSessionId);
    return sessionOf(
      await client.json(
        "POST",
        `/session/${encodeURIComponent(source.id)}/fork`,
        source.directory,
        {},
      ),
    ).id;
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
    const sessionId = sessionOf(
      await client.json("POST", "/session", input.cwd, { title: input.title }),
    ).id;
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
function assistantFailure(messages: JsonValue | undefined): string | undefined {
  for (const entry of jsonArray(messages) ?? []) {
    const info = jsonObject(jsonObject(entry)?.info);
    const error = jsonObject(info?.error);
    if (info?.role !== "assistant" || !error) continue;
    const name = jsonString(error.name) ?? "error";
    const message = jsonString(jsonObject(error.data)?.message);
    return message === undefined ? name : `${name}: ${message}`;
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
