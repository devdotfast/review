import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(async () => ({ sessionId: "forked-session" })),
}));

import * as claudeCode from "./claude-code";
import type {
  AgentServerOptions,
  NativeReviewMessage,
  SessionUpdate,
} from "./native-session";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function options(): Promise<AgentServerOptions> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-agent-server-"));
  temporaryDirectories.push(directory);
  return {
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://127.0.0.1:4000", token: "s" },
  };
}

describe("launch", () => {
  it("resumes Claude as a normal interactive terminal", async () => {
    const server = claudeCode.server(await options());
    const { sessionId, command } = await server.launch({
      session: { resume: "tutorial-thread" },
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toBe("tutorial-thread");
    expect(command.executable).toBe("claude");
    expect(command.args).not.toContain("--print");
    expect(command.args).toEqual(
      expect.arrayContaining(["--resume", "tutorial-thread"]),
    );
    expect(command.args.at(-1)).toBe("tutorial-thread");
    expect(command.env.DEV_FAST_REVIEW_AGENT_HOOK_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/claude-code\/tutorial-thread$/,
    );
    expect(command.env.DEV_FAST_REVIEW_AGENT_THREAD_URL).toBe(
      "http://127.0.0.1:4000/agent-threads",
    );
    expect(command.env.DEV_FAST_REVIEW_AGENT_THREAD_TOKEN).toBe("s");
    await server.close();
  });

  it("forks a Claude source session before opening the interactive terminal", async () => {
    const server = claudeCode.server({
      ...(await options()),
      readTranscript: async () => [],
    });
    const { sessionId, command } = await server.launch({
      session: { forkOf: "tutorial-source" },
      prompt: {
        text: "Explain this Review",
        prepared: async () => {},
        accepted: async () => {},
      },
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toBe("forked-session");
    expect(command.args).toEqual(
      expect.arrayContaining(["--resume", sessionId]),
    );
    expect(command.args.at(-1)).toBe("Explain this Review");
  });

  it("starts a fresh Claude session without resuming or forking", async () => {
    const server = claudeCode.server(await options());
    const { sessionId, command } = await server.launch({
      prompt: {
        text: "Explain this code",
        prepared: async () => {},
        accepted: async () => {},
      },
      cwd: "/tmp/tutorial",
    });
    expect(command.args).toEqual(
      expect.arrayContaining(["--session-id", sessionId]),
    );
    expect(command.args).not.toContain("--resume");
    expect(command.args).not.toContain("--fork-session");
    expect(command.args.at(-1)).toBe("Explain this code");
  });
});

describe("updates", () => {
  /** A server whose transcript reader returns the given messages. */
  async function serverOver(transcript: NativeReviewMessage[]) {
    return claudeCode.server({
      ...(await options()),
      readTranscript: async () => [...transcript],
    });
  }

  const message = (
    role: NativeReviewMessage["role"],
    body: string,
  ): NativeReviewMessage => ({
    id: `${role}-${body}`,
    role,
    body,
    createdAt: "2026-01-01T00:00:00Z",
  });

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

  /** Posts a hook the way the native hook client does. */
  async function postHook(
    env: Record<string, string>,
    payload: JsonValue,
    token = env.DEV_FAST_REVIEW_AGENT_HOOK_TOKEN,
  ): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (token) headers.set("x-review-token", token);
    return fetch(env.DEV_FAST_REVIEW_AGENT_HOOK_URL!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  it("snapshots the transcript, then forwards the tail on every hook", async () => {
    const transcript = [message("user", "hello")];
    const server = await serverOver(transcript);
    const { command } = await server.launch({
      session: { resume: "session" },
      cwd: "/tmp/tutorial",
    });
    const pipe = await server.updates("session");
    expect(pipe.snapshot).toEqual({
      sessionId: "session",
      messages: [message("user", "hello")],
    });

    transcript.push(message("assistant", "hi"));
    const response = await postHook(command.env, {
      hook_event_name: "Stop",
      session_id: "session",
    });
    expect(response.status).toBe(200);
    expect(await nextUpdates(pipe.updates, 1)).toEqual([
      { type: "message.updated", message: message("assistant", "hi") },
    ]);
    await pipe.close();
    await server.close();
  });

  it("accepts a new UUID after the inherited history, even when the Stop hook precedes disk flush", async () => {
    const inherited = message("user", "Explain this");
    const transcript = [inherited];
    const server = await serverOver(transcript);
    const accepted = vi.fn(async () => {});
    const prepared = vi.fn(async () => {});
    const { command } = await server.launch({
      session: { forkOf: "source" },
      cwd: "/tmp/tutorial",
      prompt: { text: "Explain this", prepared, accepted },
    });
    expect(prepared).toHaveBeenCalledExactlyOnceWith("forked-session");
    expect(accepted).not.toHaveBeenCalled();
    await postHook(command.env, {
      session_id: "forked-session",
      hook_event_name: "Stop",
    });
    transcript.push({ ...inherited, id: "new-question-uuid" });
    await expect
      .poll(() => accepted.mock.calls)
      .toEqual([["forked-session", "new-question-uuid"]]);
    await Promise.all([
      postHook(command.env, {
        session_id: "forked-session",
        hook_event_name: "UserPromptSubmit",
      }),
      postHook(command.env, {
        session_id: "forked-session",
        hook_event_name: "Stop",
      }),
    ]);
    expect(accepted).toHaveBeenCalledOnce();
    await server.close();
  });

  it("rejects a hook that names a different session", async () => {
    const server = await serverOver([]);
    const { command } = await server.launch({
      session: { resume: "session" },
      cwd: "/tmp/tutorial",
    });
    const response = await postHook(command.env, { session_id: "other" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('posted to session "session"'),
    });
    await server.close();
  });

  it("rejects a hook without this server's token", async () => {
    const server = await serverOver([]);
    const { command } = await server.launch({
      session: { resume: "session" },
      cwd: "/tmp/tutorial",
    });
    expect((await postHook(command.env, {}, "wrong")).status).toBe(401);
    await server.close();
  });
});
