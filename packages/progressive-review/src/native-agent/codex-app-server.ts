import {
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import {
  type JsonObject,
  type JsonValue,
  jsonObject,
  jsonProperty,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { WebSocket } from "undici";

import { isJsonRecord } from "./transcript-json";

interface PendingRequest {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CodexNotification {
  method: string;
  params: JsonObject;
}

/** One side of a JSON-RPC line stream. */
export interface Transport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** A JSON-RPC client for one `codex app-server` connection. */
export class CodexAppServerClient {
  readonly #transport: Transport;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(notification: CodexNotification) => void>();
  #nextId = 1;
  #closed = false;
  #failure: Error | undefined;

  /** Exposed for tests; production code uses the connect factories. */
  constructor(transport: Transport) {
    this.#transport = transport;
    transport.onLine((line) => this.#receive(line));
    transport.onClose((error) => {
      if (!this.#closed) {
        this.#fail(
          error ?? new Error("The Codex app-server connection closed."),
        );
      }
    });
  }

  /** Spawn a private stdio app-server. Used for one-off thread operations. */
  static async connect(): Promise<CodexAppServerClient> {
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: "/",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return CodexAppServerClient.#initialize(stdioTransport(child));
  }

  /** Attach to a shared app-server listening on a WebSocket URL. */
  static async connectWebSocket(url: string): Promise<CodexAppServerClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () =>
          reject(
            new Error(`Could not connect to the Codex app-server at ${url}.`),
          ),
        { once: true },
      );
    });
    return CodexAppServerClient.#initialize(webSocketTransport(socket));
  }

  static async #initialize(
    transport: Transport,
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(transport);
    try {
      await client.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "progressive-review",
          title: "Progressive Review",
          version: "0.0.0",
        },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed || this.#failure !== undefined;
  }

  async request(
    method: string,
    params: JsonValue,
  ): Promise<JsonValue | undefined> {
    if (this.#closed) throw new Error("The Codex app-server is closed.");
    if (this.#failure) throw this.#failure;
    const id = String(this.#nextId++);
    const response = new Promise<JsonValue | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request "${method}" timed out.`));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#transport.send(JSON.stringify({ id: Number(id), method, params }));
    return response;
  }

  notify(method: string, params: JsonValue): void {
    if (this.closed) return;
    this.#transport.send(JSON.stringify({ method, params }));
  }

  /** Server notifications (`turn/*`, `item/*`, …) in arrival order. */
  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new Error("The Codex app-server is closed."));
    await this.#transport.close();
  }

  #receive(line: string): void {
    let value: JsonValue;
    try {
      value = parseJsonText(line);
    } catch {
      this.#fail(new Error("Codex app-server wrote malformed JSON."));
      return;
    }
    if (!isJsonRecord(value)) return;
    if (value.id === undefined) {
      const method = jsonString(value.method);
      if (method !== undefined) {
        const params = jsonObject(value.params) ?? {};
        for (const listener of this.#listeners) {
          listener({ method, params });
        }
      }
      return;
    }
    const pending = this.#pending.get(String(value.id));
    if (!pending) return;
    this.#pending.delete(String(value.id));
    clearTimeout(pending.timeout);
    const error = jsonObject(value.error);
    if (error) {
      pending.reject(
        new Error(
          jsonString(error.message) ?? "Codex app-server request failed.",
        ),
      );
      return;
    }
    pending.resolve(jsonProperty(value, "result"));
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function stdioTransport(child: ChildProcessWithoutNullStreams): Transport {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const lines = createInterface({ input: child.stdout });
  return {
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => lines.on("line", listener),
    onClose: (listener) => {
      child.once("error", (error) => listener(error));
      child.once("close", (code, signal) => {
        const detail = stderr.trim();
        listener(
          new Error(
            `Codex app-server exited (code ${String(code)}, signal ${String(signal)}).${detail ? `\n\n${detail}` : ""}`,
          ),
        );
      });
    },
    close: async () => {
      child.stdin.end();
      const closed = once(child, "close").then(() => undefined);
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
      });
      await Promise.race([closed, timeout]);
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

function webSocketTransport(socket: WebSocket): Transport {
  return {
    send: (line) => socket.send(line),
    onLine: (listener) => {
      socket.addEventListener("message", (event) => {
        listener(String(event.data));
      });
    },
    onClose: (listener) => {
      socket.addEventListener("close", () => listener(), { once: true });
      socket.addEventListener(
        "error",
        () => listener(new Error("The Codex app-server WebSocket failed.")),
        { once: true },
      );
    },
    close: async () => {
      socket.close();
    },
  };
}

/**
 * Owns one shared `codex app-server --listen` process and the connection to
 * it. Started on first use; every thread Review launches lives here, and the
 * native TUI attaches to the same server with `codex --remote`.
 */
type ListeningChild = ChildProcessByStdio<null, null, Readable>;

interface StartedHost {
  child: ListeningChild;
  url: string;
  client: CodexAppServerClient;
}

export class CodexAppServerHost {
  #started: Promise<StartedHost> | undefined;

  /** WebSocket URL of the shared server. */
  async url(): Promise<string> {
    return (await this.#start()).url;
  }

  async client(): Promise<CodexAppServerClient> {
    const started = await this.#start();
    if (started.client.closed) {
      this.#started = undefined;
      return (await this.#start()).client;
    }
    return started.client;
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    const started = this.#started;
    this.#started = undefined;
    const { child, client } = await started;
    await client.close();
    if (child.exitCode === null) child.kill("SIGTERM");
  }

  #start(): Promise<StartedHost> {
    if (this.#started) return this.#started;
    const started = (async (): Promise<StartedHost> => {
      const child: ListeningChild = spawn(
        "codex",
        ["app-server", "--listen", "ws://127.0.0.1:0"],
        {
          cwd: "/",
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      child.once("exit", () => {
        this.#started = undefined;
      });
      try {
        const url = await listeningUrl(child);
        const client = await CodexAppServerClient.connectWebSocket(url);
        return { child, url, client };
      } catch (error) {
        if (child.exitCode === null) child.kill("SIGTERM");
        throw error;
      }
    })();
    this.#started = started;
    return started;
  }
}

/** The app-server announces its bound port on stderr. */
function listeningUrl(child: ListeningChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `The Codex app-server did not start listening.\n\n${stderr.trim()}`,
        ),
      );
    }, 30_000);
    timer.unref();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
      const match = /listening on: (ws:\/\/[\d.]+:\d+)/u.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code: number | null) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The Codex app-server exited (code ${String(code)}) before listening.\n\n${stderr.trim()}`,
        ),
      );
    });
  });
}

export async function forkCodexThread(input: {
  sourceThreadId: string;
  cwd: string;
}): Promise<string> {
  const client = await CodexAppServerClient.connect();
  try {
    return await forkThread(client, input);
  } finally {
    await client.close();
  }
}

export async function startCodexThread(input: {
  cwd: string;
}): Promise<string> {
  const client = await CodexAppServerClient.connect();
  try {
    return await startThread(client, input);
  } finally {
    await client.close();
  }
}

export async function forkThread(
  client: CodexAppServerClient,
  input: { sourceThreadId: string; cwd: string },
): Promise<string> {
  return threadId(
    await client.request("thread/fork", {
      threadId: input.sourceThreadId,
      cwd: input.cwd,
      ephemeral: false,
      excludeTurns: true,
    }),
    "forked",
  );
}

export async function startThread(
  client: CodexAppServerClient,
  input: { cwd: string },
): Promise<string> {
  return threadId(
    await client.request("thread/start", { cwd: input.cwd, ephemeral: false }),
    "new",
  );
}

function threadId(result: JsonValue | undefined, kind: string): string {
  const id = jsonString(jsonObject(jsonObject(result)?.thread)?.id);
  if (!id) throw new Error(`Codex returned an invalid ${kind} thread.`);
  return id;
}
