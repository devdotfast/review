import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAgentServer,
  type CodexHost,
  projectCodexNotification,
  projectCodexTurns,
} from "./codex";
import {
  CodexAppServerClient,
  type CodexNotification,
  type Transport,
} from "./codex-app-server";
import type { AgentServerOptions, SessionUpdate } from "./native-session";

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

async function nextUpdates(
  updates: AsyncIterable<SessionUpdate>,
  count: number,
): Promise<SessionUpdate[]> {
  const collected: SessionUpdate[] = [];
  for await (const update of updates) {
    collected.push(update);
    if (collected.length === count) break;
  }
  return collected;
}

describe("projectCodexTurns", () => {
  it("keeps every user message and the final agent message of completed turns", () => {
    const messages = projectCodexTurns([
      {
        status: "completed",
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_010,
        items: [
          userItem("u1", "hello"),
          agentItem("a1", "thinking…"),
          agentItem("a2", "final answer"),
        ],
      },
      {
        status: "inProgress",
        startedAt: 1_700_000_020,
        completedAt: null,
        items: [userItem("u2", "and?"), agentItem("a3", "partial")],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        body: "hello",
        createdAt: "2023-11-14T22:13:20.000Z",
        itemId: "u1",
      },
      {
        role: "assistant",
        body: "final answer",
        createdAt: "2023-11-14T22:13:30.000Z",
        itemId: "a2",
      },
      {
        role: "user",
        body: "and?",
        createdAt: "2023-11-14T22:13:40.000Z",
        itemId: "u2",
      },
    ]);
  });

  it("projects live notifications the same way", () => {
    expect(
      projectCodexNotification({
        method: "item/completed",
        params: {
          threadId: "t",
          item: userItem("u1", "hi"),
          completedAtMs: 1_000,
        },
      }),
    ).toEqual([
      {
        role: "user",
        body: "hi",
        createdAt: "1970-01-01T00:00:01.000Z",
        itemId: "u1",
      },
    ]);
    expect(
      projectCodexNotification({
        method: "item/completed",
        params: {
          threadId: "t",
          item: agentItem("a1", "streamed"),
          completedAtMs: 1,
        },
      }),
    ).toEqual([]);
    expect(
      projectCodexNotification({
        method: "turn/completed",
        params: {
          threadId: "t",
          turn: {
            status: "completed",
            completedAt: 2,
            items: [agentItem("a1", "done")],
          },
        },
      }),
    ).toEqual([
      {
        role: "assistant",
        body: "done",
        createdAt: "1970-01-01T00:00:02.000Z",
        itemId: "a1",
      },
    ]);
  });
});

describe("CodexAgentServer", () => {
  it("forks the thread, starts the turn, waits for the user message, then attaches the TUI", async () => {
    const host = fakeHost({
      "thread/fork": () => ({ thread: { id: "forked" } }),
      "thread/read": () => ({
        thread: {
          id: "forked",
          turns: [
            {
              status: "inProgress",
              startedAt: 1,
              completedAt: null,
              items: [userItem("u1", "Explain this")],
            },
          ],
        },
      }),
      "turn/start": (params) => {
        queueMicrotask(() =>
          host.emit({
            method: "item/completed",
            params: {
              threadId: params.threadId as string,
              item: userItem("u1", "Explain this"),
              completedAtMs: 5,
            },
          }),
        );
        return { turn: { id: "turn-1" } };
      },
    });
    const server = new CodexAgentServer(await options(), host);
    const { sessionId, command } = await server.launch({
      session: { forkOf: "source" },
      prompt: "Explain this",
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toBe("forked");
    expect(host.requests.map((request) => request.method)).toEqual([
      "thread/fork",
      "turn/start",
    ]);
    expect(command.executable).toBe("codex");
    expect(command.args).toEqual(
      expect.arrayContaining([
        "--remote",
        "ws://127.0.0.1:4500",
        "resume",
        "forked",
      ]),
    );
    expect(command.args).not.toContain("--enable");
    expect(command.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(command.env.DEV_FAST_REVIEW_AGENT_THREAD_URL).toBe(
      "http://127.0.0.1:4000/native-agent-events/codex/forked/thread",
    );
    // The prompt arrived through the stream and again from thread/read;
    // the snapshot has it once.
    const pipe = await server.updates("forked");
    expect(pipe.snapshot.messages.map((message) => message.body)).toEqual([
      "Explain this",
    ]);
    await pipe.close();
  });

  it("reads history on subscribe and streams the final agent message per turn", async () => {
    const host = fakeHost({
      "thread/resume": () => ({ thread: { id: "t" } }),
      "thread/read": () => ({
        thread: {
          id: "t",
          turns: [
            {
              status: "completed",
              startedAt: 1,
              completedAt: 2,
              items: [userItem("u1", "first"), agentItem("a1", "answer one")],
            },
          ],
        },
      }),
    });
    const server = new CodexAgentServer(await options(), host);
    const pipe = await server.updates("t");
    expect(host.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/read",
    ]);
    expect(pipe.snapshot.messages.map((message) => message.body)).toEqual([
      "first",
      "answer one",
    ]);
    host.emit({
      method: "item/completed",
      params: {
        threadId: "t",
        item: userItem("u2", "second"),
        completedAtMs: 3,
      },
    });
    host.emit({
      method: "turn/completed",
      params: {
        threadId: "t",
        turn: {
          status: "completed",
          completedAt: 4,
          items: [agentItem("a2", "answer two")],
        },
      },
    });
    // A re-read of the same items must not duplicate them.
    host.emit({
      method: "item/completed",
      params: {
        threadId: "t",
        item: userItem("u2", "second"),
        completedAtMs: 3,
      },
    });
    expect(
      (await nextUpdates(pipe.updates, 2)).map((update) => update.message.body),
    ).toEqual(["second", "answer two"]);
    await pipe.close();
  });

  it("treats a thread without a rollout as empty until it materializes", async () => {
    const host = fakeHost({
      "thread/resume": () => {
        throw new Error("no rollout found for thread id t");
      },
      "thread/read": () => {
        throw new Error(
          "thread t is not materialized yet; includeTurns is unavailable before first user message",
        );
      },
    });
    const server = new CodexAgentServer(await options(), host);
    const pipe = await server.updates("t");
    expect(pipe.snapshot.messages).toEqual([]);
    await pipe.close();
  });
});
