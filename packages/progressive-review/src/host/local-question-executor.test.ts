import { randomUUID } from "node:crypto";

import { HOST_LIMITS } from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../native-agent/async-queue";
import type {
  AgentServer,
  LaunchInput,
  ReviewAgentHarness,
  SessionUpdate,
} from "../native-agent/native-session";
import { REVIEW_AGENT_THREAD_TOKEN_ENV } from "../native-agent/terminal-command";
import {
  type LocalQuestionAnswer,
  LocalQuestionExecutor,
  type LocalQuestionStart,
} from "./local-question-executor";

describe("fresh local question execution", () => {
  it("advertises only available, correctly scoped execution paths", async () => {
    const agent = fakeAgent("codex");
    const withoutTerminal = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
    });
    expect(
      (await withoutTerminal.capabilities())
        .filter((entry) => entry.available)
        .map((entry) => entry.harness),
    ).toEqual(["codex"]);
    const withTerminal = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async (harness) => harness !== "pi",
      openTerminal: async () => {},
    });
    const capabilities = await withTerminal.capabilities();
    expect(
      capabilities
        .filter((entry) => entry.available)
        .map((entry) => entry.harness),
    ).toEqual(["codex", "claude-code"]);
    expect(
      capabilities.find((entry) => entry.harness === "opencode"),
    ).toMatchObject({
      available: false,
      isolation: "trusted_local",
      reason: expect.stringContaining("shared tool process"),
    });
    await expect(withTerminal.start(input("opencode"))).rejects.toThrow(
      "per-question Review credentials",
    );
    expect(agent.inputs).toHaveLength(0);
  });

  it.each(["codex", "claude-code", "pi"] as const)(
    "starts %s without an author session and delivers only a completed answer",
    async (harness) => {
      const agent = fakeAgent(harness);
      const openTerminal = vi.fn<() => Promise<void>>(async () => {});
      const executor = new LocalQuestionExecutor({
        agentServer: () => agent.server,
        isAvailable: async () => true,
        openTerminal,
      });
      const request = input(harness);
      agent.queue.push(
        message(
          "user-copy",
          "user",
          "The prompt is already stored by the host.",
        ),
      );
      agent.queue.push(message("answer", "assistant", "A retained answer."));
      agent.queue.push(
        message("answer", "assistant", "A duplicate must not replace it."),
      );
      agent.queue.push({ type: "status.changed", status: "idle" });
      const handle = await executor.start(request);
      const result = await handle.completion;
      expect(result).toMatchObject({
        status: "completed",
        answer: {
          runId: request.runId,
          questionId: request.questionId,
          session: handle.session,
          nativeMessageIds: ["answer"],
          body: "A retained answer.",
        },
      });
      expect(request.onCompleted).toHaveBeenCalledOnce();
      expect(agent.inputs[0]?.session).toBeUndefined();
      expect(agent.inputs[0]?.environment).toMatchObject({
        DEV_REVIEW_HOST_TOKEN: request.credentials.token,
        DEV_REVIEW_HOST_ID: request.credentials.hostId,
        DEV_REVIEW_WORKSPACE_ID: request.credentials.workspaceId,
        [REVIEW_AGENT_THREAD_TOKEN_ENV]: request.credentials.token,
      });
      expect(agent.inputs[0]?.prompt?.text).toContain("Retained source quote");
      expect(agent.inputs[0]?.prompt?.text).not.toContain(
        request.credentials.token,
      );
      expect(JSON.stringify(result)).not.toContain(request.credentials.token);
      expect(openTerminal).toHaveBeenCalledOnce();
      expect(agent.closed()).toBe(true);
    },
  );

  it("waits for the final idle signal and successful storage before completing", async () => {
    const agent = fakeAgent("codex");
    let save!: () => void;
    const saved = new Promise<void>((resolve) => {
      save = resolve;
    });
    const onCompleted = vi.fn<LocalQuestionStart["onCompleted"]>(
      async () => saved,
    );
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
    });
    const handle = await executor.start({ ...input("codex"), onCompleted });
    agent.queue.push(message("answer", "assistant", "Final answer"));
    await Promise.resolve();
    expect(onCompleted).not.toHaveBeenCalled();
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });
    agent.queue.push({ type: "status.changed", status: "idle" });
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    save();
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("freezes input before asynchronous launch and does not expose credentials in the prompt", async () => {
    const agent = fakeAgent("codex");
    let available!: () => void;
    const gate = new Promise<void>((resolve) => {
      available = resolve;
    });
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => {
        await gate;
        return true;
      },
    });
    const request = input("codex");
    const starting = executor.start(request);
    request.context.question = "mutated after submission";
    request.credentials.token = "replacement-not-authorized-token";
    available();
    const handle = await starting;
    expect(agent.inputs[0]?.prompt?.text).toContain("What does this code do?");
    expect(agent.inputs[0]?.prompt?.text).not.toContain(
      "mutated after submission",
    );
    expect(agent.inputs[0]?.environment?.DEV_REVIEW_HOST_TOKEN).toBe(
      "private-scoped-question-credential",
    );
    await executor.close();
    await expect(handle.completion).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  it("prevents duplicate concurrent launches for the same saved run", async () => {
    const agent = fakeAgent("codex");
    let available!: () => void;
    const gate = new Promise<void>((resolve) => {
      available = resolve;
    });
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => {
        await gate;
        return true;
      },
    });
    const request = input("codex");
    const pending = executor.start(request);
    await expect(executor.start(request)).rejects.toThrow("already executing");
    available();
    const handle = await pending;
    expect(agent.inputs).toHaveLength(1);
    await executor.close();
    await handle.completion;
  });

  it.each(["failed", "interrupted"] as const)(
    "returns %s without saving partial answers or raw harness errors",
    async (status) => {
      const agent = fakeAgent("codex");
      const executor = new LocalQuestionExecutor({
        agentServer: () => agent.server,
        isAvailable: async () => true,
      });
      const request = input("codex");
      const handle = await executor.start(request);
      agent.queue.push(message("partial", "assistant", "Not a completed turn"));
      agent.queue.push({
        type: "status.changed",
        status,
        error: `private /some/path ${request.credentials.token}`,
      });
      const outcome = await handle.completion;
      expect(outcome.status).toBe(status);
      expect(JSON.stringify(outcome)).not.toContain(request.credentials.token);
      expect(JSON.stringify(outcome)).not.toContain("/some/path");
      expect(request.onCompleted).not.toHaveBeenCalled();
    },
  );

  it("does not report completion if the persistence callback fails", async () => {
    const agent = fakeAgent("codex");
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
    });
    const handle = await executor.start({
      ...input("codex"),
      onCompleted: async () => {
        throw new Error("private database path");
      },
    });
    agent.queue.push(message("answer", "assistant", "Answer"));
    agent.queue.push({ type: "status.changed", status: "idle" });
    await expect(handle.completion).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "INTERNAL",
        message: expect.stringContaining("could not be saved"),
      },
    });
  });

  it("does not save a completed answer that exposes its scoped credential", async () => {
    const agent = fakeAgent("codex");
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
    });
    const request = input("codex");
    const handle = await executor.start(request);
    agent.queue.push(
      message("answer", "assistant", `Sensitive: ${request.credentials.token}`),
    );
    agent.queue.push({ type: "status.changed", status: "idle" });
    const outcome = await handle.completion;
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "INTERNAL" },
    });
    expect(JSON.stringify(outcome)).not.toContain(request.credentials.token);
    expect(request.onCompleted).not.toHaveBeenCalled();
  });

  it("captures a Codex answer even if its optional terminal cannot open", async () => {
    const agent = fakeAgent("codex");
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
      openTerminal: async () => {
        throw new Error("native bridge unavailable");
      },
    });
    const handle = await executor.start(input("codex"));
    agent.queue.push(message("answer", "assistant", "Answer without terminal"));
    agent.queue.push({ type: "status.changed", status: "idle" });
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("fails launch if the terminal required by Claude cannot open", async () => {
    const agent = fakeAgent("claude-code");
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
      openTerminal: async () => {
        throw new Error("private terminal error");
      },
    });
    await expect(executor.start(input("claude-code"))).rejects.toThrow(
      "required native question terminal",
    );
    expect(agent.closed()).toBe(true);
  });

  it("bounds prompts and completed answers, and refuses credential-containing context", async () => {
    const agent = fakeAgent("codex");
    const executor = new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async () => true,
    });
    const request = input("codex");
    await expect(
      executor.start({
        ...request,
        context: { ...request.context, question: "\u0001".repeat(32 * 1024) },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(
      executor.start({
        ...request,
        context: {
          ...request.context,
          material: {
            ...request.context.material,
            documentJson: {
              state: "complete",
              text: request.credentials.token,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(agent.inputs).toHaveLength(0);
    const handle = await executor.start(request);
    agent.queue.push(
      message(
        "oversized",
        "assistant",
        "x".repeat(HOST_LIMITS.commentBytes + 1),
      ),
    );
    await expect(handle.completion).resolves.toMatchObject({
      status: "failed",
      error: { code: "RESOURCE_LIMIT" },
    });
    expect(request.onCompleted).not.toHaveBeenCalled();
  });
});

function input(harness: ReviewAgentHarness): LocalQuestionStart {
  return {
    runId: randomUUID(),
    questionId: randomUUID(),
    harness,
    repositoryPath: "/trusted/repository",
    context: {
      id: randomUUID(),
      reviewId: randomUUID(),
      reviewVersion: 3,
      question: "What does this code do?",
      material: {
        schemaVersion: 1,
        review: { title: { state: "complete", text: "Review" } },
        binding: {
          repositoryId: randomUUID(),
          baseCommit: "1".repeat(40),
          headCommit: "2".repeat(40),
        },
        mapVersions: { base: null, head: null },
        originalTarget: { kind: "document", reviewVersion: 3 },
        viewedTarget: {
          threadId: randomUUID(),
          reviewVersion: 3,
          status: "exact",
          target: { kind: "document", reviewVersion: 3 },
        },
        sourceEvidence: null,
        documentJson: { state: "complete", text: "Retained source quote" },
        priorMessages: [],
        priorMessagesOmitted: 0,
      },
    },
    credentials: {
      url: "http://127.0.0.1:4000",
      hostId: randomUUID(),
      workspaceId: randomUUID(),
      token: "private-scoped-question-credential",
    },
    onCompleted: vi.fn<(answer: LocalQuestionAnswer) => Promise<void>>(
      async () => {},
    ),
  };
}

function fakeAgent(harness: ReviewAgentHarness) {
  const queue = new AsyncQueue<SessionUpdate>();
  const inputs: LaunchInput[] = [];
  let closed = false;
  const server: AgentServer = {
    harness,
    async launch(input) {
      if (input.session)
        throw new Error("The author session must not be used.");
      inputs.push(input);
      return {
        sessionId: randomUUID(),
        command: {
          cwd: input.cwd,
          executable: harness,
          args: [input.prompt?.text ?? ""],
          env: { ...input.environment },
        },
      };
    },
    async updates() {
      return {
        updates: queue,
        close: async () => {
          closed = true;
          queue.close();
        },
      };
    },
    async interrupt() {
      throw new Error("No Stop button is part of this adapter.");
    },
    async close() {
      queue.close();
    },
  };
  return { server, queue, inputs, closed: () => closed };
}

function message(
  id: string,
  role: "assistant" | "user",
  body: string,
): SessionUpdate {
  return {
    type: "message.updated",
    message: { id, role, body, createdAt: "2026-09-10T12:00:00Z" },
  };
}
