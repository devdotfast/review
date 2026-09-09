import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type {
  CreateReviewCommentInput,
  JsonValue,
} from "@dev.fast/review-protocol";
import { expect, it, vi } from "vitest";

import { AsyncQueue } from "../native-agent/async-queue";
import type {
  AgentServer,
  SessionUpdate,
} from "../native-agent/native-session";
import { reviewThreadEnvironment } from "../native-agent/terminal-command";
import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { ReviewThreadsService } from "../review-threads-service";
import { runReviewThreadsGet } from "../threads-cli";
import { createGlobalReviewServer } from "./desktop-server";
import { createReviewApi } from "./review-api";

async function fixture(
  options: { pauseLaunch?: boolean; restoreSession?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "review-flow-"));
  const reviewPath = join(directory, "review.mdx");
  const queue = new AsyncQueue<SessionUpdate>();
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseLaunch = () => {};
  const released = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let terminalCount = 0;
  let interrupted = false;
  const server: AgentServer = {
    harness: "claude-code",
    async launch(input) {
      markStarted();
      if (options.pauseLaunch) await released;
      if (input.prompt) {
        const user: SessionUpdate = {
          type: "message.updated",
          message: {
            id: input.prompt.id,
            role: "user",
            body: input.prompt.text,
            createdAt: "2026-09-09T00:00:00Z",
          },
        };
        const reply: SessionUpdate = {
          type: "message.updated",
          message: {
            id: `reply-${input.prompt.id}`,
            role: "assistant",
            body: `Answer for ${input.prompt.id}`,
            createdAt: "2026-09-09T00:00:01Z",
          },
        };
        queue.push(user);
        queue.push(reply);
        queue.push(reply);
      } else {
        queue.push({
          type: "message.updated",
          message: {
            id: "tui-question",
            role: "user",
            body: "Question from TUI",
            createdAt: "2026-09-09T00:01:00Z",
          },
        });
        queue.push({
          type: "message.updated",
          message: {
            id: "tui-answer",
            role: "assistant",
            body: "Answer from TUI",
            createdAt: "2026-09-09T00:01:01Z",
          },
        });
      }
      return {
        sessionId: "conversation",
        command: { executable: "claude", args: [], env: {}, cwd: directory },
      };
    },
    async updates() {
      return { updates: queue, close: async () => queue.close() };
    },
    async interrupt() {
      interrupted = true;
      queue.push({ type: "status.changed", status: "interrupted" });
    },
    async close() {
      queue.close();
    },
  };
  if (options.restoreSession) {
    const stored = new ReviewThreadsService({ reviewPath, author: "Reviewer" });
    stored.dispatch({
      command: "comment-draft.create",
      mutationId: "saved-draft",
      input: {
        threadId: "thread",
        messageId: "saved-question",
        target: { kind: "document" },
        body: "Question saved-question",
      },
    });
    stored.setAgentSession({
      mutationId: "saved-binding",
      threadId: "thread",
      agentSession: { harness: "claude-code", sessionId: "conversation" },
    });
  }
  const api = createReviewApi({
    mode: { kind: "live" },
    reviewPath,
    stateReviewPath: reviewPath,
    reviewDocumentsDir: directory,
    rootPath: directory,
    toolingRoot: directory,
    reviewToken: "test",
    session: {
      rootPath: directory,
      baseRef: "main",
      appUrl: "http://localhost:4000",
      reviewPath,
      startedAt: 1,
      agent: { harness: "claude-code", sessionId: "author" },
    },
    agentServer: () => server,
    openNativeAgentTerminal: async () => {
      terminalCount += 1;
    },
  });
  const post = (path: string, body: JsonValue) =>
    api.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const comment = (id: string): CreateReviewCommentInput => ({
    threadId: "thread",
    messageId: id,
    target: { kind: "document" },
    body: `Question ${id}`,
  });
  const draft = async (id: string) => {
    const response = await post("/thread-commands", {
      command: "comment-draft.create",
      mutationId: `save-${id}`,
      input: comment(id),
    });
    expect(response.status).toBe(200);
  };
  const snapshot = () =>
    new ReviewThreadsService({ reviewPath, author: "Reviewer" }).snapshot();
  return {
    post,
    directory,
    findAgentThread: api.findAgentThread,
    comment,
    draft,
    snapshot,
    started,
    release: releaseLaunch,
    terminalCount: () => terminalCount,
    interrupted: () => interrupted,
    async close() {
      await api.close();
      await server.close();
      closeAllReviewThreadStores();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("keeps captured replies in the draft exactly once across a resumed follow-up", async () => {
  const test = await fixture();
  try {
    await test.draft("ask");
    expect((await test.post("/agent-runs", test.comment("ask"))).status).toBe(
      202,
    );
    await expect
      .poll(() =>
        test
          .snapshot()
          .drafts.thread?.thread.messages.map((message) => message.body),
      )
      .toEqual(["Question ask", "Answer for ask"]);
    expect(test.snapshot().comments).toEqual({});
    expect(
      (
        await test.post("/comments/thread/agent-interrupt", {
          messageId: "ask",
        })
      ).status,
    ).toBe(200);
    await test.draft("followup");
    expect(
      (await test.post("/agent-runs", test.comment("followup"))).status,
    ).toBe(202);
    await expect
      .poll(() =>
        test
          .snapshot()
          .drafts.thread?.thread.messages.map((message) => message.body),
      )
      .toEqual([
        "Question ask",
        "Answer for ask",
        "Question followup",
        "Answer for followup",
      ]);
    expect(test.snapshot().drafts.thread?.thread.agentSession).toEqual({
      harness: "claude-code",
      sessionId: "conversation",
    });
    expect(test.terminalCount()).toBe(2);
  } finally {
    await test.close();
  }
});

it("captures TUI replies when manually reopening a stored session with no active observer", async () => {
  const test = await fixture({ restoreSession: true });
  try {
    expect(
      (await test.post("/comments/thread/agent-terminal", {})).status,
    ).toBe(200);
    await expect
      .poll(() =>
        test
          .snapshot()
          .drafts.thread?.thread.messages.map((message) => message.body),
      )
      .toEqual([
        "Question saved-question",
        "Question from TUI",
        "Answer from TUI",
      ]);
    expect(test.terminalCount()).toBe(1);
  } finally {
    await test.close();
  }
});

it("cancels a pending launch without opening a terminal or deleting the draft", async () => {
  const test = await fixture({ pauseLaunch: true });
  try {
    await test.draft("ask");
    const request = test.post("/agent-runs", test.comment("ask"));
    await test.started;
    expect(
      (
        await test.post("/comments/thread/agent-interrupt", {
          messageId: "ask",
        })
      ).status,
    ).toBe(200);
    test.release();
    expect((await request).status).toBe(202);
    expect(test.interrupted()).toBe(true);
    expect(test.terminalCount()).toBe(0);
    await expect
      .poll(() =>
        test
          .snapshot()
          .drafts.thread?.thread.messages.map((message) => message.body),
      )
      .toEqual(["Question ask", "Answer for ask"]);
  } finally {
    await test.close();
  }
});

it("lets the CLI read an authenticated draft before its native session is bound", async () => {
  const test = await fixture();
  const home = await mkdtemp(join(tmpdir(), "review-thread-lookup-"));
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const desktop = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "lookup-token",
    discoveryPath: join(home, "desktop.json"),
    tutorialAgentResolver: async () => "claude-code",
    tutorialAuthoringSessionFactory: async () => ({
      harness: "claude-code",
      sessionId: "author",
    }),
    sessionHandlerFactory: async () => ({
      token: "lookup-token",
      handle: async () => new Response(null, { status: 404 }),
      findAgentThread: test.findAgentThread,
      close: async () => {},
    }),
  });
  try {
    await test.draft("ask");
    expect(test.snapshot().drafts.thread?.thread.agentSession).toBeUndefined();
    await desktop.listen();
    const opened = await fetch(`${desktop.url}/tutorial/open`, {
      method: "POST",
      headers: { "x-review-token": "lookup-token" },
    });
    expect(opened.status).toBe(200);
    expect((await fetch(`${desktop.url}/agent-threads/thread`)).status).toBe(
      401,
    );
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk;
        callback();
      },
    });
    await runReviewThreadsGet({
      cwd: test.directory,
      threadId: "thread",
      stdout,
      env: reviewThreadEnvironment({
        baseUrl: desktop.url,
        token: "lookup-token",
      }),
    });
    expect(JSON.parse(output)).toMatchObject({
      state: "draft",
      comment: { messages: [{ id: "ask", body: "Question ask" }] },
    });
    expect(test.snapshot().drafts.thread?.thread.agentSession).toBeUndefined();
  } finally {
    await desktop.close();
    await test.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
