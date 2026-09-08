import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentServerOptions, SessionUpdate } from "./native-session";
import { PiAgentServer } from "./pi";
import { projectBranch } from "./pi-bridge-extension";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function options(): Promise<AgentServerOptions> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-pi-"));
  temporaryDirectories.push(directory);
  return {
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://127.0.0.1:4000", token: "s" },
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

async function postBridge(
  env: Record<string, string>,
  payload: JsonValue,
): Promise<Response> {
  return fetch(env.DEV_FAST_REVIEW_AGENT_BRIDGE_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": env.DEV_FAST_REVIEW_AGENT_BRIDGE_TOKEN!,
    },
    body: JSON.stringify(payload),
  });
}

describe("projectBranch", () => {
  it("keeps user messages and the final assistant message before each user turn", () => {
    const entries = [
      {
        id: "1",
        parentId: null,
        type: "message",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        id: "2",
        parentId: "1",
        type: "message",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "draft" }],
          stopReason: "toolUse",
        },
      },
      {
        id: "3",
        parentId: "2",
        type: "message",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
        },
      },
      {
        id: "4",
        parentId: "3",
        type: "message",
        timestamp: "2026-01-01T00:00:03Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          stopReason: "stop",
        },
      },
      {
        id: "5",
        parentId: "4",
        type: "message",
        timestamp: "2026-01-01T00:00:04Z",
        message: { role: "user", content: "again" },
      },
    ];
    const expected = [
      { id: "1", role: "user", body: "hi", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "4",
        role: "assistant",
        body: "final",
        createdAt: "2026-01-01T00:00:03Z",
      },
      {
        id: "5",
        role: "user",
        body: "again",
        createdAt: "2026-01-01T00:00:04Z",
      },
    ];
    expect(projectBranch(entries)).toEqual(expected);
  });
});

describe("PiAgentServer", () => {
  it("captures the inherited branch before accepting the new native entry", async () => {
    const server = new PiAgentServer(await options());
    const accepted = vi.fn(async () => {});
    const prepared = vi.fn(async () => {});
    const { sessionId, command } = await server.launch({
      session: { forkOf: "source" },
      cwd: "/tmp",
      prompt: { text: "Explain this", prepared, accepted },
    });
    expect(prepared).toHaveBeenCalledExactlyOnceWith(sessionId);
    const old = {
      id: "old",
      role: "user",
      body: "Explain this",
      createdAt: "2026-09-07T00:00:00Z",
    };
    expect(
      (
        await postBridge(command.env, {
          sessionId,
          phase: "session-start",
          messages: [old],
        })
      ).status,
    ).toBe(200);
    expect(accepted).not.toHaveBeenCalled();
    const messages = [old, { ...old, id: "ask" }];
    expect(
      (await postBridge(command.env, { sessionId, phase: "update", messages }))
        .status,
    ).toBe(200);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(sessionId, "ask");
    await postBridge(command.env, { sessionId, phase: "update", messages });
    expect(accepted).toHaveBeenCalledOnce();
    await server.close();
  });

  it("forwards the tail of each bridge post and snapshots the latest projection", async () => {
    const server = new PiAgentServer(await options());
    const { sessionId, command } = await server.launch({ cwd: "/tmp" });
    const pipe = await server.updates(sessionId);
    expect(pipe.snapshot.messages).toEqual([]);

    const first = {
      id: "1",
      role: "user",
      body: "hi",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const second = {
      id: "2",
      role: "assistant",
      body: "hello",
      createdAt: "2026-01-01T00:00:01Z",
    };
    expect(
      (await postBridge(command.env, { sessionId, messages: [first] })).status,
    ).toBe(200);
    expect(
      (await postBridge(command.env, { sessionId, messages: [first, second] }))
        .status,
    ).toBe(200);
    expect(await nextUpdates(pipe.updates, 2)).toEqual([
      { type: "message.updated", message: first },
      { type: "message.updated", message: second },
    ]);
    expect((await server.updates(sessionId)).snapshot.messages).toEqual([
      first,
      second,
    ]);

    expect(
      (await postBridge(command.env, { sessionId: "other", messages: [] }))
        .status,
    ).toBe(400);
    await pipe.close();
    await server.close();
  });
});
