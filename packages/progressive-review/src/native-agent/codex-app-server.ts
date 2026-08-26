import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { isJsonRecord } from "./transcript-json";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.#receive(line);
    });
    child.once("error", (error) => this.#fail(error));
    child.once("close", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new Error(
            `Codex app-server exited (code ${String(code)}, signal ${String(signal)}).`,
          ),
        );
      }
    });
  }

  static async connect(): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(
      spawn("codex", ["app-server", "--stdio"], {
        cwd: "/",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
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

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("The Codex app-server is closed.");
    const id = String(this.#nextId++);
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request "${method}" timed out.`));
      }, 60_000);
      timeout.unref();
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#child.stdin.write(
      `${JSON.stringify({ id: Number(id), method, params })}\n`,
    );
    return response;
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    const closed = once(this.#child, "close").then(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
    });
    await Promise.race([closed, timeout]);
    if (this.#child.exitCode === null) this.#child.kill("SIGTERM");
  }

  #receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#fail(new Error("Codex app-server wrote malformed JSON."));
      return;
    }
    if (!isJsonRecord(value) || value.id === undefined) return;
    const pending = this.#pending.get(String(value.id));
    if (!pending) return;
    this.#pending.delete(String(value.id));
    clearTimeout(pending.timeout);
    if (isJsonRecord(value.error)) {
      pending.reject(
        new Error(
          typeof value.error.message === "string"
            ? value.error.message
            : "Codex app-server request failed.",
        ),
      );
      return;
    }
    pending.resolve(value.result);
  }

  #fail(error: Error): void {
    const detail = this.#stderr.trim();
    const failure = detail ? new Error(`${error.message}\n\n${detail}`) : error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.#pending.clear();
  }
}

export async function readCodexThread(threadId: string): Promise<unknown> {
  const client = await CodexAppServerClient.connect();
  try {
    await client.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    return await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
  } finally {
    await client.close();
  }
}

export async function forkCodexThread(input: {
  sourceThreadId: string;
  cwd: string;
}): Promise<string> {
  const client = await CodexAppServerClient.connect();
  try {
    const result = await client.request("thread/fork", {
      threadId: input.sourceThreadId,
      cwd: input.cwd,
      ephemeral: false,
      excludeTurns: true,
    });
    if (
      !isJsonRecord(result) ||
      !isJsonRecord(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.thread.id.length === 0
    ) {
      throw new Error("Codex returned an invalid forked thread.");
    }
    return result.thread.id;
  } finally {
    await client.close();
  }
}

export async function startCodexThread(input: {
  cwd: string;
}): Promise<string> {
  const client = await CodexAppServerClient.connect();
  try {
    const result = await client.request("thread/start", {
      cwd: input.cwd,
      ephemeral: false,
    });
    if (
      !isJsonRecord(result) ||
      !isJsonRecord(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.thread.id.length === 0
    ) {
      throw new Error("Codex returned an invalid new thread.");
    }
    return result.thread.id;
  } finally {
    await client.close();
  }
}
