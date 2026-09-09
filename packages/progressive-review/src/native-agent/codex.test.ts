import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAgentServer, type CodexHost } from "./codex";
import {
  CodexAppServerClient,
  type CodexNotification,
  type Transport,
} from "./codex-app-server";
import type { AgentServerOptions } from "./native-session";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function options(): Promise<AgentServerOptions> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-codex-"));
  temporaryDirectories.push(directory);
  return {
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://127.0.0.1:4000", token: "s" },
  };
}

const userItem = (id: string, text: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text, text_elements: [] }],
});
const agentItem = (id: string, text: string) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
});

/** A scripted app-server: answers requests by method, emits notifications on demand. */
function fakeHost(handlers: {
  [method: string]: (params: JsonObject) => JsonValue;
}): CodexHost & {
  requests: Array<{ method: string; params: JsonObject }>;
  emit(notification: CodexNotification): void;
} {
  const lineListeners: Array<(line: string) => void> = [];
  const requests: Array<{ method: string; params: JsonObject }> = [];
  const transport: Transport = {
    send(line) {
      // SAFETY: the client under test writes exactly this JSON-RPC request shape.
      const message = JSON.parse(line) as {
        id?: number;
        method: string;
        params: JsonObject;
      };
      if (message.id === undefined) return;
      requests.push({ method: message.method, params: message.params });
      const handler = handlers[message.method];
      const reply = handler
        ? (() => {
            try {
              return { id: message.id, result: handler(message.params) };
            } catch (error) {
              return {
                id: message.id,
                error: { code: -32600, message: (error as Error).message },
              };
            }
          })()
        : { id: message.id, result: {} };
      queueMicrotask(() => {
        for (const listener of lineListeners) listener(JSON.stringify(reply));
      });
    },
    onLine: (listener) => lineListeners.push(listener),
    onClose: () => undefined,
    close: async () => undefined,
  };
  const client = new CodexAppServerClient(transport);
  return {
    requests,
    url: async () => "ws://127.0.0.1:4500",
    client: async () => client,
    close: async () => undefined,
    emit: (notification) => {
      for (const listener of lineListeners)
        listener(JSON.stringify(notification));
    },
  };
}

describe("Codex live capture", () => {
  it("buffers a fast reply before subscription and keeps a resumed follow-up on the same stream", async () => {
    let turn = 0;
    const host = fakeHost({
      "thread/fork": () => ({ thread: { id: "forked" } }),
      "turn/start": () => {
        const id = `turn-${++turn}`;
        host.emit({
          method: "item/completed",
          params: {
            threadId: "forked",
            turnId: id,
            item: userItem(`u${turn}`, "question"),
            completedAtMs: 1000,
          },
        });
        host.emit({
          method: "turn/completed",
          params: {
            threadId: "forked",
            turn: {
              id,
              status: "completed",
              completedAt: 2,
              items: [agentItem(`a${turn}`, "answer")],
            },
          },
        });
        return { turn: { id } };
      },
    });
    const server = new CodexAgentServer(await options(), host);
    await server.launch({
      session: { forkOf: "source" },
      cwd: "/tmp",
      prompt: { id: "review-ask", text: "question" },
    });
    const pipe = await server.updates("forked");
    const iterator = pipe.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "message.updated",
      message: { id: "review-ask", role: "user" },
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "message.updated",
      message: { id: "a1", body: "answer" },
    });
    expect((await iterator.next()).value).toEqual({
      type: "status.changed",
      status: "idle",
    });
    await server.launch({
      session: { resume: "forked" },
      cwd: "/tmp",
      prompt: { id: "follow-up", text: "question" },
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "message.updated",
      message: { id: "follow-up" },
    });
    await pipe.close();
    host.emit({
      method: "item/completed",
      params: {
        threadId: "forked",
        turnId: "offline",
        item: userItem("offline", "not captured"),
        completedAtMs: 3000,
      },
    });
    await server.launch({
      session: { resume: "forked" },
      cwd: "/tmp",
      prompt: { id: "after-reopen", text: "question" },
    });
    const reopened = await server.updates("forked");
    await pipe.close(); // A late disposal of the old view must not close the new queue.
    const resumed = reopened.updates[Symbol.asyncIterator]();
    expect((await resumed.next()).value).toMatchObject({
      message: { id: "after-reopen" },
    });
    expect((await resumed.next()).value).toMatchObject({
      message: { id: "a3", body: "answer" },
    });
    expect(
      host.requests.some((request) => request.method === "thread/read"),
    ).toBe(false);
    await server.close();
  });

  it("does not finish interrupt until the active turn settles", async () => {
    const host = fakeHost({
      "thread/start": () => ({ thread: { id: "t" } }),
      "turn/start": () => {
        host.emit({
          method: "item/completed",
          params: {
            threadId: "t",
            turnId: "run",
            item: userItem("u", "work"),
            completedAtMs: 1000,
          },
        });
        return { turn: { id: "run" } };
      },
    });
    const server = new CodexAgentServer(await options(), host);
    await server.launch({ cwd: "/tmp", prompt: { id: "ask", text: "work" } });
    let finished = false;
    const stop = server.interrupt("t").then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    host.emit({
      method: "turn/completed",
      params: {
        threadId: "t",
        turn: { id: "run", status: "interrupted", items: [] },
      },
    });
    await stop;
    expect(finished).toBe(true);
    await server.close();
  });
});
