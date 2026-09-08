import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as claudeCode from "./claude-code";
import {
  type ClaudeReviewMessage,
  projectClaudeReviewMessages,
} from "./claude-transcript";
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

describe("updates", () => {
  /** A server whose transcript reader returns the given messages. */
  async function serverOver(transcript: ClaudeReviewMessage[]) {
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
      transcript_path: "/tmp/session.jsonl",
    });
    expect(response.status).toBe(200);
    expect(await nextUpdates(pipe.updates, 1)).toEqual([
      { type: "message.updated", message: message("assistant", "hi") },
    ]);
    await pipe.close();
    await server.close();
  });

  it("accepts only the submitted prompt's UUID, including when its transcript write is delayed", async () => {
    const inherited = {
      type: "user",
      uuid: "inherited-user",
      timestamp: "2026-09-07T00:00:00Z",
      promptId: "old-prompt",
      message: { role: "user", content: "Explain this" },
    };
    const transcript = [inherited];
    const server = claudeCode.server({
      ...(await options()),
      readTranscript: async () => projectClaudeReviewMessages(transcript),
    });
    const accepted = vi.fn<
      (sessionId: string, messageId: string) => Promise<void>
    >(async () => {});
    const prepared = vi.fn<(sessionId: string) => Promise<void>>(
      async () => {},
    );
    const { sessionId, command } = await server.launch({
      session: { forkOf: "source" },
      cwd: "/tmp/tutorial",
      prompt: { text: "Explain this", prepared, accepted },
    });
    const hook = { session_id: sessionId, transcript_path: "/tmp/fork.jsonl" };
    expect(prepared).toHaveBeenCalledExactlyOnceWith(sessionId);
    await postHook(command.env, { ...hook, hook_event_name: "SessionStart" });
    expect(accepted).not.toHaveBeenCalled();
    await postHook(command.env, {
      ...hook,
      hook_event_name: "UserPromptSubmit",
      prompt_id: "ask-prompt",
    });
    expect(accepted).not.toHaveBeenCalled();
    await postHook(command.env, {
      ...hook,
      hook_event_name: "Stop",
      prompt_id: "ask-prompt",
    });
    transcript.push({
      ...inherited,
      uuid: "new-question-uuid",
      promptId: "ask-prompt",
    });
    await expect
      .poll(() => accepted.mock.calls)
      .toEqual([[sessionId, "new-question-uuid"]]);
    await Promise.all([
      postHook(command.env, {
        ...hook,
        hook_event_name: "UserPromptSubmit",
        prompt_id: "ask-prompt",
      }),
      postHook(command.env, {
        ...hook,
        hook_event_name: "Stop",
        prompt_id: "ask-prompt",
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
    const response = await postHook(command.env, {
      session_id: "other",
      transcript_path: "/tmp/other.jsonl",
      hook_event_name: "Stop",
    });
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
