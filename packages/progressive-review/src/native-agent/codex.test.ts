import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  emit(notification: CodexNotification): void;
} {
  const lineListeners: Array<(line: string) => void> = [];
  const transport: Transport = {
    send(line) {
      // SAFETY: the client under test writes exactly this JSON-RPC request shape.
      const message = JSON.parse(line) as {
        id?: number;
        method: string;
        params: JsonObject;
      };
      if (message.id === undefined) return;
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
        id: "turn-1",
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
        id: "turn-2",
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
        id: "u1",
        turnId: "turn-1",
      },
      {
        role: "assistant",
        body: "final answer",
        createdAt: "2023-11-14T22:13:30.000Z",
        id: "a2",
        turnId: "turn-1",
      },
      {
        role: "user",
        body: "and?",
        createdAt: "2023-11-14T22:13:40.000Z",
        id: "u2",
        turnId: "turn-2",
      },
    ]);
  });

  it("projects live notifications the same way", () => {
    expect(
      projectCodexNotification({
        method: "item/completed",
        params: {
          threadId: "t",
          turnId: "turn-1",
          item: userItem("u1", "hi"),
          completedAtMs: 1_000,
        },
      }),
    ).toEqual([
      {
        role: "user",
        body: "hi",
        createdAt: "1970-01-01T00:00:01.000Z",
        id: "u1",
        turnId: "turn-1",
      },
    ]);
    expect(
      projectCodexNotification({
        method: "item/completed",
        params: {
          threadId: "t",
          turnId: "turn-1",
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
          turnId: "turn-1",
          turn: {
            id: "turn-1",
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
        id: "a1",
        turnId: "turn-1",
      },
    ]);
  });
});

describe("CodexAgentServer", () => {
  it.each(["new", "fork", "resume"] as const)(
    "attaches shell tools before the first turn of a %s session",
    async (mode) => {
      let prepared = false;
      const accepted = vi.fn(async () => {});
      let executionEnv: JsonObject | undefined;
      const configure = (params: JsonObject) => {
        const config = params.config as JsonObject;
        executionEnv = config["shell_environment_policy.set"] as JsonObject;
        return { thread: { id: "attached" } };
      };
      const host = fakeHost({
        "thread/start": configure,
        "thread/fork": configure,
        "thread/resume": configure,
        "turn/start": () => {
          // This executes before launch returns a terminal command. The
          // original bug only configured that later terminal's environment.
          expect(prepared).toBe(true);
          expect(executionEnv).toMatchObject({
            DEV_FAST_REVIEW_AGENT_THREAD_URL:
              "http://127.0.0.1:4000/agent-threads",
            DEV_FAST_REVIEW_AGENT_THREAD_TOKEN: "s",
          });
          queueMicrotask(() =>
            host.emit({
              method: "item/completed",
              params: {
                threadId: "attached",
                turnId: "unrelated-turn",
                item: userItem("other", "Read the comment"),
              },
            }),
          );
          queueMicrotask(() =>
            host.emit({
              method: "item/completed",
              params: {
                threadId: "attached",
                turnId: "turn-1",
                item: userItem("u1", "Read the comment"),
                completedAtMs: 5,
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        },
      });
      const server = new CodexAgentServer(await options(), host);
      try {
        await server.launch({
          cwd: "/tmp/tutorial",
          prompt: {
            text: "Read the comment",
            prepared: async () => {
              prepared = true;
            },
            accepted,
          },
          ...(mode === "fork" ? { session: { forkOf: "source" } } : {}),
          ...(mode === "resume" ? { session: { resume: "attached" } } : {}),
        });
        expect(accepted).toHaveBeenCalledExactlyOnceWith("attached", "u1");
      } finally {
        await server.close();
      }
    },
  );

  it("places inherited history before a question received live before hydration", async () => {
    const host = fakeHost({
      "thread/fork": () => ({ thread: { id: "forked" } }),
      "thread/read": () => ({
        thread: {
          id: "forked",
          turns: [
            {
              id: "old-turn",
              status: "completed",
              startedAt: 0,
              completedAt: 1,
              items: [
                userItem("old-u", "Prior task"),
                agentItem("old-a", "Prior answer"),
              ],
            },
            {
              id: "turn-1",
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
              turnId: "turn-1",
              item: userItem("u1", "Explain this"),
              completedAtMs: 5,
            },
          }),
        );
        return { turn: { id: "turn-1" } };
      },
    });
    const server = new CodexAgentServer(await options(), host);
    await server.launch({
      session: { forkOf: "source" },
      prompt: {
        text: "Explain this",
        prepared: async () => {},
        accepted: async () => {},
      },
      cwd: "/tmp/tutorial",
    });
    // The new question arrived live before hydration. Inherited history
    // must precede it, or the mirror mistakes that history for new replies.
    const pipe = await server.updates("forked");
    expect(pipe.snapshot.messages.map((message) => message.body)).toEqual([
      "Prior task",
      "Prior answer",
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
              id: "turn-1",
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
    expect(pipe.snapshot.messages.map((message) => message.body)).toEqual([
      "first",
      "answer one",
    ]);
    host.emit({
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "turn-1",
        item: userItem("u2", "second"),
        completedAtMs: 3,
      },
    });
    host.emit({
      method: "turn/completed",
      params: {
        threadId: "t",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
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
        turnId: "turn-1",
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
