import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, test } from "vitest";

import {
  CodexIpcProtocolError,
  CodexIpcUnavailableError,
  wakeCodexThread,
  wakeCodexThreadWithRetry,
} from "./codex-thread-wakeup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Codex thread wake-up", () => {
  test("routes a text follow-up to the desktop task owner", async () => {
    const fixture = await ipcFixture();
    const received: JsonObject[] = [];
    fixture.server.on("connection", (socket) => {
      readFrames(socket, (message) => {
        received.push(message);
        if (message.method === "initialize") {
          writeFrame(socket, {
            method: "initialize",
            requestId: message.requestId,
            result: { clientId: "wait-client-1" },
            resultType: "success",
            type: "response",
          });
          return;
        }
        writeFrame(socket, {
          handledByClientId: "desktop-client-1",
          method: "thread-follower-start-turn",
          requestId: message.requestId,
          result: { result: { turnId: "turn-1" } },
          resultType: "success",
          type: "response",
        });
      });
    });

    await expect(
      wakeCodexThread({
        clientUserMessageId: "message-1",
        env: { CODEX_HOME: fixture.root },
        prompt: "Workflow run run-1 completed.",
        threadId: "thread-1",
      }),
    ).resolves.toBeUndefined();

    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      method: "thread-follower-start-turn",
      params: {
        conversationId: "thread-1",
        turnStartParams: {
          clientUserMessageId: "message-1",
          input: [
            {
              text: "Workflow run run-1 completed.",
              text_elements: [],
              type: "text",
            },
          ],
        },
      },
      sourceClientId: "wait-client-1",
      version: 1,
    });
    await fixture.close();
  });

  test("surfaces a routed wake-up rejection", async () => {
    const fixture = await ipcFixture();
    fixture.server.on("connection", (socket) => {
      readFrames(socket, (message) => {
        if (message.method === "initialize") {
          writeFrame(socket, {
            method: "initialize",
            requestId: message.requestId,
            result: { clientId: "wait-client-1" },
            resultType: "success",
            type: "response",
          });
          return;
        }
        writeFrame(socket, {
          error: "no-client-found",
          requestId: message.requestId,
          resultType: "error",
          type: "response",
        });
      });
    });

    await expect(
      wakeCodexThread({
        clientUserMessageId: "message-2",
        env: { CODEX_HOME: fixture.root },
        prompt: "done",
        threadId: "missing-thread",
      }),
    ).rejects.toThrow(
      new CodexIpcProtocolError(
        'Codex IPC request "thread-follower-start-turn" failed: no-client-found.',
      ),
    );
    await fixture.close();
  });

  test("retries transient desktop delivery failures with one stable message ID", async () => {
    const calls: string[] = [];
    let attempt = 0;
    const input = {
      clientUserMessageId: "stable-message",
      env: {},
      prompt: "done",
      threadId: "thread-1",
    };

    await wakeCodexThreadWithRetry(input, {
      retryIntervalMs: 1,
      send: async (next) => {
        calls.push(next.clientUserMessageId);
        attempt += 1;
        if (attempt < 3) {
          throw new CodexIpcUnavailableError("/tmp/missing.sock");
        }
      },
      sleep: async () => undefined,
      timeoutMs: 100,
    });

    expect(calls).toEqual([
      "stable-message",
      "stable-message",
      "stable-message",
    ]);
  });
});

async function ipcFixture() {
  const root = await mkdtemp(join(tmpdir(), "dev-fast-codex-ipc-test-"));
  roots.push(root);
  const ipcDir = join(root, "ipc");
  const socketPath = join(ipcDir, "ipc.sock");
  await mkdir(ipcDir);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    root,
    server,
  };
}

function readFrames(
  socket: Socket,
  onMessage: (message: JsonObject) => void,
): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const bodyBytes = buffered.readUInt32LE(0);
      if (buffered.length < bodyBytes + 4) return;
      const body = buffered.subarray(4, bodyBytes + 4);
      buffered = buffered.subarray(bodyBytes + 4);
      const message = parseJsonText(body.toString("utf8"));
      if (!isJsonObject(message)) throw new Error("frame is not an object");
      onMessage(message);
    }
  });
}

function writeFrame(socket: Socket, message: JsonObject): void {
  const json = JSON.stringify(message);
  const frame = Buffer.alloc(4 + Buffer.byteLength(json));
  frame.writeUInt32LE(Buffer.byteLength(json), 0);
  frame.write(json, 4);
  socket.write(frame);
}
