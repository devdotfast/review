import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { isJsonRecord } from "./transcript-json";

export const OPENCODE_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface OpenCodeHttpClientInput {
  baseUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
}

export class OpenCodeHttpError extends Error {
  constructor(
    message: string,
    readonly responseReceived: boolean,
  ) {
    super(message);
  }
}

/** Narrow authenticated HTTP boundary shared by Review's two OpenCode owners. */
export class OpenCodeHttpClient {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly #fetch: typeof fetch;
  readonly #authorization: string;
  version = "unknown";

  constructor(input: OpenCodeHttpClientInput) {
    this.baseUrl = input.baseUrl;
    this.username = input.username;
    this.password = input.password;
    this.#fetch = input.fetch ?? fetch;
    this.#authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`;
  }

  async json(
    pathname: string,
    directory?: string,
    init: RequestInit & { timeout?: number } = {},
  ): Promise<unknown> {
    const response = await this.request(pathname, directory, init);
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw this.contract(`${pathname} returned invalid JSON`);
    }
  }

  async request(
    pathname: string,
    directory?: string,
    init: RequestInit & { timeout?: number } = {},
  ): Promise<Response> {
    const url = new URL(pathname, this.baseUrl);
    if (directory) url.searchParams.set("directory", directory);
    const { timeout = REQUEST_TIMEOUT_MS, ...requestInit } = init;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...requestInit,
        headers: {
          authorization: this.#authorization,
          ...(requestInit.body ? { "content-type": "application/json" } : {}),
          ...requestInit.headers,
        },
        signal: requestInit.signal ?? AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new OpenCodeHttpError(
        this.contractMessage(
          error instanceof Error ? error.message : String(error),
        ),
        false,
      );
    }
    if (!response.ok) {
      throw new OpenCodeHttpError(
        this.contractMessage(
          `${pathname} failed (${response.status}): ${await response.text()}`,
        ),
        true,
      );
    }
    return response;
  }

  contract(message: string): Error {
    return new Error(this.contractMessage(message));
  }

  private contractMessage(message: string): string {
    return `OpenCode ${message} (reported version ${this.version}).`;
  }
}

export interface OpenCodeServerProcess {
  child: ChildProcess;
  http: OpenCodeHttpClient;
}

export interface StartOpenCodeServerInput {
  cwd: string;
  attempts?: number;
  detached?: boolean;
  stdin?: "ignore" | "pipe";
  spawn?: typeof spawn;
  fetch?: typeof fetch;
  reservePort?: () => Promise<number>;
  shutdownTimeoutMs?: number;
}

export async function startOpenCodeServer(
  input: StartOpenCodeServerInput,
): Promise<OpenCodeServerProcess> {
  const spawnProcess = input.spawn ?? spawn;
  const reservePort = input.reservePort ?? reserveOpenCodePort;
  let lastError: unknown;
  for (let attempt = 0; attempt < (input.attempts ?? 1); attempt += 1) {
    const port = await reservePort();
    const username = "review";
    const password = randomUUID();
    const child = spawnProcess(
      "opencode",
      ["serve", "--hostname", OPENCODE_HOST, "--port", String(port)],
      {
        cwd: input.cwd,
        detached: input.detached ?? false,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: [input.stdin ?? "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let spawnError: Error | undefined;
    let logs = "";
    child.once("error", (error) => {
      spawnError = error;
    });
    for (const output of [child.stdout, child.stderr]) {
      output?.setEncoding("utf8");
      output?.on("data", (chunk: string) => {
        logs = `${logs}${chunk}`.slice(-8_000);
      });
    }
    const http = new OpenCodeHttpClient({
      baseUrl: `http://${OPENCODE_HOST}:${port}`,
      username,
      password,
      fetch: input.fetch,
    });
    try {
      await waitForOpenCodeHealth(http, child, () => spawnError);
      // The log buffer exists only for startup diagnostics; detach so
      // steady-state server output costs nothing for the process lifetime.
      for (const output of [child.stdout, child.stderr]) {
        output?.removeAllListeners("data");
        output?.resume();
      }
      return { child, http };
    } catch (error) {
      lastError = error;
      await stopOpenCodeProcess(
        child,
        input.shutdownTimeoutMs,
        input.detached === true,
      );
      if (attempt + 1 >= (input.attempts ?? 1)) {
        const detail = logs.trim();
        throw http.contract(
          `server did not become ready.${error instanceof Error ? ` ${error.message}` : ""}${detail ? `\n\n${detail}` : ""}`,
        );
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OpenCode server did not become ready.");
}

export async function stopOpenCodeProcess(
  child: ChildProcess,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  processGroup = false,
): Promise<void> {
  if (!isOpenCodeProcessRunning(child)) return;
  signalOpenCodeProcess(child, "SIGTERM", processGroup);
  if (await waitForProcessExit(child, timeoutMs)) return;
  signalOpenCodeProcess(child, "SIGKILL", processGroup);
  if (!(await waitForProcessExit(child, timeoutMs))) {
    throw new Error("OpenCode server did not exit after SIGKILL.");
  }
}

export async function readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) onData(dataLines.join("\n"));
    dataLines = [];
  };
  const line = (value: string) => {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") dataLines.push(content);
  };
  const consume = () => {
    while (buffer.length > 0) {
      const match = /[\r\n]/u.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (buffer[index] === "\r" && index === buffer.length - 1) {
        break;
      }
      const width =
        buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      line(buffer.slice(0, index));
      buffer = buffer.slice(index + width);
    }
  };
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      consume();
    }
    // SSE dispatches only on a blank line. EOF discards an incomplete event.
  } finally {
    reader.releaseLock();
  }
}

export async function reserveOpenCodePort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, OPENCODE_HOST, resolve);
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

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isOpenCodeMessageId(value: unknown): value is string {
  return nonEmptyString(value) && value.startsWith("msg_");
}

export function isOpenCodeProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function waitForOpenCodeHealth(
  http: OpenCodeHttpClient,
  child: ChildProcess,
  spawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline && isOpenCodeProcessRunning(child)) {
    if (spawnError()) throw spawnError();
    try {
      const health = await http.json("/global/health", undefined, {
        timeout: 1_000,
      });
      if (
        !isJsonRecord(health) ||
        health.healthy !== true ||
        !nonEmptyString(health.version)
      ) {
        if (isJsonRecord(health) && nonEmptyString(health.version)) {
          http.version = health.version;
        }
        throw http.contract("health returned an invalid response");
      }
      http.version = health.version;
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OpenCode server exited during startup.");
}

function signalOpenCodeProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  try {
    if (process.platform !== "win32" && processGroup && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The child may not own a process group (source-freeze servers do not).
  }
  child.kill(signal);
}

function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!isOpenCodeProcessRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", closed);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", closed);
  });
}
