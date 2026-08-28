import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  type OpenCodeSourceClient,
  OpenCodeSourceHttpClient,
  forkOpenCodeSourceSession,
  validateOpenCodeToolCallMessage,
} from "./opencode-source";

function messages(parts: unknown[] = [{ type: "tool", tool: "review" }]) {
  return [
    {
      info: { id: "msg_user-1", sessionID: "session-1", role: "user" },
      parts: [{ type: "text", text: "Create a Review, then explain it." }],
    },
    {
      info: {
        id: "msg_message-1",
        sessionID: "session-1",
        role: "assistant",
      },
      parts,
    },
    {
      info: {
        id: "msg_later-1",
        sessionID: "session-1",
        role: "assistant",
      },
      parts: [{ type: "text", text: "Later output" }],
    },
  ];
}

describe("OpenCode source freezing", () => {
  it("validates the assistant tool call before using it as the exclusive fork boundary", async () => {
    const client: OpenCodeSourceClient = {
      messages: vi.fn<OpenCodeSourceClient["messages"]>(async () => messages()),
      fork: vi.fn<OpenCodeSourceClient["fork"]>(async () => ({
        id: "frozen-session",
      })),
      close: vi.fn<OpenCodeSourceClient["close"]>(async () => undefined),
    };

    await expect(
      forkOpenCodeSourceSession({
        sessionId: "session-1",
        messageId: "msg_message-1",
        sourceDirectory: "/workspace/subdir",
        sourceWorktree: "/workspace",
        targetDirectory: "/managed/head",
        connect: async () => client,
      }),
    ).resolves.toBe("frozen-session");
    expect(client.messages).toHaveBeenCalledWith(
      "session-1",
      "/workspace/subdir",
    );
    expect(client.fork).toHaveBeenCalledWith(
      "session-1",
      "msg_message-1",
      "/managed/head",
    );
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("rejects unknown, mismatched, malformed, and ambiguous boundaries", () => {
    const expected = {
      sessionId: "session-1",
      messageId: "msg_message-1",
    };
    expect(() => validateOpenCodeToolCallMessage({}, expected)).toThrow(
      "invalid session message list",
    );
    expect(() =>
      validateOpenCodeToolCallMessage(messages(), {
        ...expected,
        messageId: "message-1",
      }),
    ).toThrow("message ID is invalid");
    expect(() => validateOpenCodeToolCallMessage([], expected)).toThrow(
      "was not found",
    );
    expect(() =>
      validateOpenCodeToolCallMessage([messages()[1], messages()[1]], expected),
    ).toThrow("ambiguous");
    expect(() =>
      validateOpenCodeToolCallMessage(
        [
          {
            ...messages()[1],
            info: {
              id: "msg_message-1",
              sessionID: "other-session",
              role: "assistant",
            },
          },
        ],
        expected,
      ),
    ).toThrow("does not match");
    expect(() =>
      validateOpenCodeToolCallMessage(
        [messages([{ type: "tool", tool: "bash" }])[1]],
        expected,
      ),
    ).toThrow("not a Review tool call");
    expect(() =>
      validateOpenCodeToolCallMessage(
        [
          messages([
            { type: "tool", tool: "review" },
            { type: "tool", tool: "review" },
          ])[1],
        ],
        expected,
      ),
    ).toThrow("ambiguous Review tool calls");
  });

  it("forces and awaits shutdown of a stubborn source-freeze server", async () => {
    const child = new EventEmitter() as ChildProcess;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      spawnargs: [],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>((signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          Object.defineProperty(child, "exitCode", {
            value: 0,
            configurable: true,
          });
          queueMicrotask(() => child.emit("close", 0, "SIGKILL"));
        }
        return true;
      }),
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/global/health"
        ? Response.json({ healthy: true, version: "1.18.23" })
        : new Response(null, { status: 204 });
    });
    const client = await OpenCodeSourceHttpClient.connect("/workspace", {
      spawn: (() => child) as never,
      fetch: fetchMock,
      reservePort: async () => 43123,
      shutdownTimeoutMs: 1,
    });

    await client.close();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
  });
});
