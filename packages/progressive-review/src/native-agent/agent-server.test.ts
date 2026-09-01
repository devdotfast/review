import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as claudeCode from "./claude-code";
import * as codex from "./codex";
import type { HarnessDialect } from "./harness";
import { HookObservedAgentServer } from "./hook-observed-server";
import type { NativeReviewMessage, SessionUpdate } from "./native-session";
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

const hookEndpoint = { baseUrl: "http://127.0.0.1:4000/hooks", token: "s" };

async function runtimeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-agent-server-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("launch", () => {
  it("resumes Claude as a normal interactive terminal", async () => {
    const server = claudeCode.server({
      runtimeDirectory: await runtimeDirectory(),
    });
    const { sessionId, terminal } = await server.launch({
      session: { resume: "tutorial-thread" },
      cwd: "/tmp/tutorial",
      hookEndpoint,
    });
    expect(sessionId).toBe("tutorial-thread");
    expect(terminal.executable).toBe("claude");
    expect(terminal.args).not.toContain("--print");
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--resume", "tutorial-thread"]),
    );
    expect(terminal.args.at(-1)).toBe("tutorial-thread");
    expect(terminal.env.DEV_FAST_REVIEW_AGENT_HOOK_URL).toBe(
      "http://127.0.0.1:4000/hooks/claude-code/tutorial-thread",
    );
  });

  it("forks a Claude source session in the normal interactive terminal", async () => {
    const server = claudeCode.server({
      runtimeDirectory: await runtimeDirectory(),
    });
    const { sessionId, terminal } = await server.launch({
      session: { forkOf: "tutorial-source" },
      prompt: "Explain this Review",
      cwd: "/tmp/tutorial",
      hookEndpoint,
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
    const server = claudeCode.server({
      runtimeDirectory: await runtimeDirectory(),
    });
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
      hookEndpoint,
    });
    expect(terminal.args).toEqual(
      expect.arrayContaining(["--session-id", sessionId]),
    );
    expect(terminal.args).not.toContain("--resume");
    expect(terminal.args).not.toContain("--fork-session");
    expect(terminal.args.at(-1)).toBe("Explain this code");
  });

  it("starts a fresh Pi session with a generated session ID", async () => {
    const server = pi.server({ runtimeDirectory: await runtimeDirectory() });
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
      hookEndpoint,
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
      runtimeDirectory: await runtimeDirectory(),
      dependencies: { startCodexThread, forkCodexThread },
    });
    const { sessionId, terminal } = await server.launch({
      prompt: "Explain this code",
      cwd: "/tmp/tutorial",
      hookEndpoint,
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
      terminalCommand: async () => {
        throw new Error("not used");
      },
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

  it("snapshots the transcript, then forwards the tail on every hook", async () => {
    const transcript = [message("user", "hello")];
    const server = new HookObservedAgentServer(fakeDialect(transcript), {
      runtimeDirectory: await runtimeDirectory(),
    });
    const pipe = await server.updates("session");
    expect(pipe.snapshot).toEqual({
      sessionId: "session",
      status: "pending",
      messages: [message("user", "hello")],
    });

    transcript.push(message("assistant", "hi"));
    server.receiveHookEvent("session", {
      hook_event_name: "Stop",
      session_id: "session",
    });
    expect(await nextUpdates(pipe.updates, 3)).toEqual([
      { type: "attached" },
      { type: "turn.completed" },
      { type: "message.updated", message: message("assistant", "hi") },
    ]);
    await pipe.close();
  });

  it("tracks status across turn hooks", async () => {
    const server = new HookObservedAgentServer(fakeDialect([]), {
      runtimeDirectory: await runtimeDirectory(),
    });
    const pipe = await server.updates("session");
    server.receiveHookEvent("session", { hook_event_name: "UserPromptSubmit" });
    server.receiveHookEvent("session", { hook_event_name: "Stop" });
    server.receiveHookEvent("session", { hook_event_name: "SessionEnd" });
    expect(await nextUpdates(pipe.updates, 4)).toEqual([
      { type: "attached" },
      { type: "turn.started" },
      { type: "turn.completed" },
      { type: "closed", reason: "session ended" },
    ]);
    expect((await server.updates("session")).snapshot.status).toBe("closed");
    await pipe.close();
    await server.close();
  });

  it("rejects a hook that names a different session", async () => {
    const server = new HookObservedAgentServer(fakeDialect([]), {
      runtimeDirectory: await runtimeDirectory(),
    });
    expect(() =>
      server.receiveHookEvent("session", { session_id: "other" }),
    ).toThrow(/posted to session "session"/);
  });
});
