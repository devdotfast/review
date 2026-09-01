import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as claudeCode from "./claude-code";
import * as codex from "./codex";
import type { HarnessDialect } from "./harness";
import { HookObservedAgentServer } from "./hook-observed-server";
import type {
  AgentServerOptions,
  NativeReviewMessage,
  SessionUpdate,
} from "./native-session";
import * as pi from "./pi";

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
    const { sessionId, terminal } = await server.launch({
      session: { resume: "tutorial-thread" },
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toBe("tutorial-thread");
    expect(terminal.executable).toBe("claude");
    expect(terminal.args).not.toContain("--print");
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--resume", "tutorial-thread"]),
    );
    expect(terminal.args.at(-1)).toBe("tutorial-thread");
    expect(terminal.env.DEV_FAST_REVIEW_AGENT_HOOK_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/claude-code\/tutorial-thread$/,
    );
    expect(terminal.env.DEV_FAST_REVIEW_AGENT_THREAD_URL).toBe(
      "http://127.0.0.1:4000/native-agent-events/claude-code/tutorial-thread/thread",
    );
    expect(terminal.env.DEV_FAST_REVIEW_AGENT_THREAD_TOKEN).toBe("s");
    await server.close();
  });

  it("forks a Claude source session in the normal interactive terminal", async () => {
    const server = claudeCode.server(await options());
    const { sessionId, terminal } = await server.launch({
      session: { forkOf: "tutorial-source" },
      prompt: "Explain this Review",
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminal.args).toEqual(
      expect.arrayContaining([
        "--resume",
        "tutorial-source",
        "--fork-session",
        "--session-id",
        sessionId,
      ]),
    );
    expect(terminal.args.at(-1)).toBe("Explain this Review");
  });

  it("starts a fresh Claude session without resuming or forking", async () => {
    const server = claudeCode.server(await options());
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
    });
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--session-id", sessionId]),
    );
    expect(terminal.args).not.toContain("--resume");
    expect(terminal.args).not.toContain("--fork-session");
    expect(terminal.args.at(-1)).toBe("Explain this code");
  });

  it("starts a fresh Pi session with a generated session ID", async () => {
    const server = pi.server(await options());
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
    });
    expect(terminal.executable).toBe("pi");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--session-id", sessionId]),
    );
    expect(terminal.args).not.toContain("--session");
    expect(terminal.args).not.toContain("--fork");
  });

  it("creates a Codex thread before opening it in the terminal", async () => {
    const startCodexThread = vi.fn<
      NonNullable<codex.CodexDialectDependencies["startCodexThread"]>
    >(async () => "codex-new-thread");
    const forkCodexThread = vi.fn<
      NonNullable<codex.CodexDialectDependencies["forkCodexThread"]>
    >(async () => "codex-forked-thread");
    const server = codex.server({
      ...(await options()),
      dependencies: { startCodexThread, forkCodexThread },
    });
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
    });
    expect(startCodexThread).toHaveBeenCalledWith({ cwd: "/tmp/tutorial" });
    expect(forkCodexThread).not.toHaveBeenCalled();
    expect(sessionId).toBe("codex-new-thread");
    expect(terminal.executable).toBe("codex");
    expect(terminal.args).toEqual(
      expect.arrayContaining([
        "resume",
        "codex-new-thread",
        "Explain this code",
      ]),
    );
  });
});

describe("updates", () => {
  function fakeDialect(transcript: NativeReviewMessage[]): HarnessDialect {
    return {
      harness: "claude-code",
      reserveSessionId: async () => "session",
      terminalCommand: async (input) => ({
        launchId: input.launchId,
        harness: "claude-code",
        cwd: input.cwd,
        executable: "claude",
        args: [],
        env: input.env,
      }),
      readMessages: async () => [...transcript],
    };
  }

  const message = (
    role: NativeReviewMessage["role"],
    body: string,
  ): NativeReviewMessage => ({ role, body, createdAt: "2026-01-01T00:00:00Z" });

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
    payload: unknown,
    token = env.DEV_FAST_REVIEW_AGENT_HOOK_TOKEN,
  ): Promise<Response> {
    return fetch(env.DEV_FAST_REVIEW_AGENT_HOOK_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-review-token": token } : {}),
      },
      body: JSON.stringify(payload),
    });
  }

  it("snapshots the transcript, then forwards the tail on every hook", async () => {
    const transcript = [message("user", "hello")];
    const server = new HookObservedAgentServer(
      fakeDialect(transcript),
      await options(),
    );
    const { terminal } = await server.launch({ cwd: "/tmp/tutorial" });
    const pipe = await server.updates("session");
    expect(pipe.snapshot).toEqual({
      sessionId: "session",
      messages: [message("user", "hello")],
    });

    transcript.push(message("assistant", "hi"));
    const response = await postHook(terminal.env, {
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

  it("rejects a hook that names a different session", async () => {
    const server = new HookObservedAgentServer(
      fakeDialect([]),
      await options(),
    );
    const { terminal } = await server.launch({ cwd: "/tmp/tutorial" });
    const response = await postHook(terminal.env, { session_id: "other" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('posted to session "session"'),
    });
    await server.close();
  });

  it("rejects a hook without this server's token", async () => {
    const server = new HookObservedAgentServer(
      fakeDialect([]),
      await options(),
    );
    const { terminal } = await server.launch({ cwd: "/tmp/tutorial" });
    expect((await postHook(terminal.env, {}, "wrong")).status).toBe(401);
    await server.close();
  });
});
