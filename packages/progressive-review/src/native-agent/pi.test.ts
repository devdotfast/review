import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

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
      { role: "user", body: "hi", createdAt: "2026-01-01T00:00:00Z" },
      { role: "assistant", body: "final", createdAt: "2026-01-01T00:00:03Z" },
      { role: "user", body: "again", createdAt: "2026-01-01T00:00:04Z" },
    ];
    expect(projectBranch(entries)).toEqual(expected);
    // getBranch walks leaf to root; the projection accepts that order too.
    expect(projectBranch([...entries].reverse())).toEqual(expected);
  });
});

describe("PiAgentServer", () => {
  it("launches pi with the bridge extension and a generated session id", async () => {
    const server = new PiAgentServer(await options());
    const { sessionId, command } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
    });
    expect(command.executable).toBe("pi");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.args).toEqual(
      expect.arrayContaining([
        "-e",
        expect.stringContaining("pi-bridge-extension"),
        "--session-id",
        sessionId,
      ]),
    );
    expect(command.args).not.toContain("--session");
    expect(command.args).not.toContain("--fork");
    expect(command.args.at(-1)).toBe("Explain this code");
    expect(command.env.DEV_FAST_REVIEW_AGENT_BRIDGE_URL).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/pi/${sessionId}$`),
    );
    expect(command.env.DEV_FAST_REVIEW_AGENT_HOOK_URL).toBeUndefined();
    await server.close();
  });

  it("forks and resumes through pi's own flags", async () => {
    const server = new PiAgentServer(await options());
    const fork = await server.launch({
      session: { forkOf: "src" },
      cwd: "/tmp",
    });
    expect(fork.command.args).toEqual(
      expect.arrayContaining(["--fork", "src", "--session-id", fork.sessionId]),
    );
    const resume = await server.launch({
      session: { resume: "old" },
      cwd: "/tmp",
    });
    expect(resume.sessionId).toBe("old");
    expect(resume.command.args).toEqual(
      expect.arrayContaining(["--session", "old"]),
    );
    await server.close();
  });

  it("forwards the tail of each bridge post and snapshots the latest projection", async () => {
    const server = new PiAgentServer(await options());
    const { sessionId, command } = await server.launch({ cwd: "/tmp" });
    const pipe = await server.updates(sessionId);
    expect(pipe.snapshot.messages).toEqual([]);

    const first = {
      role: "user",
      body: "hi",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const second = {
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
