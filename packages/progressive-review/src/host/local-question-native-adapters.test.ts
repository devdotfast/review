import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { ClaudeAgentServer } from "../native-agent/claude-code";
import { CodexAgentServer, type CodexHost } from "../native-agent/codex";
import {
  CodexAppServerClient,
  type CodexNotification,
  type Transport,
} from "../native-agent/codex-app-server";
import { PiAgentServer } from "../native-agent/pi";
import { REVIEW_AGENT_THREAD_TOKEN_ENV } from "../native-agent/terminal-command";
import {
  LocalQuestionExecutor,
  type LocalQuestionStart,
} from "./local-question-executor";

describe("scoped fresh native launch contracts", () => {
  it("sets Codex's per-thread tool credential before the first prompt starts", async () => {
    const runtimeDirectory = await mkdtemp(
      path.join(tmpdir(), "question-codex-"),
    );
    const request = question(runtimeDirectory);
    let toolEnvironment: JsonObject = {};
    let submittedPrompt = "";
    const host = scriptedCodex({
      "thread/start": (params) => {
        toolEnvironment =
          jsonObject(
            jsonObject(params.config)?.["shell_environment_policy.set"],
          ) ?? {};
        return { thread: { id: "fresh-question" } };
      },
      "thread/fork": () => {
        throw new Error("The author transcript is unavailable.");
      },
      "turn/start": (params) => {
        submittedPrompt =
          jsonString(jsonObject(jsonArray(params.input)?.[0])?.text) ?? "";
        const scoped =
          toolEnvironment.DEV_REVIEW_HOST_TOKEN === request.credentials.token &&
          toolEnvironment[REVIEW_AGENT_THREAD_TOKEN_ENV] ===
            request.credentials.token;
        host.emit({
          method: "item/completed",
          params: {
            threadId: "fresh-question",
            turnId: "turn",
            item: {
              type: "userMessage",
              id: "user",
              content: [
                { type: "text", text: submittedPrompt, text_elements: [] },
              ],
            },
          },
        });
        host.emit({
          method: "turn/completed",
          params: {
            threadId: "fresh-question",
            turn: {
              id: "turn",
              status: "completed",
              items: [
                {
                  type: "agentMessage",
                  id: "answer",
                  text: scoped
                    ? "The initial tool environment was scoped."
                    : "The tool environment had author privileges.",
                  phase: null,
                },
              ],
            },
          },
        });
        return { turn: { id: "turn" } };
      },
    });
    const server = new CodexAgentServer(
      {
        runtimeDirectory,
        desktopEndpoint: {
          baseUrl: request.credentials.url,
          token: "native-author-credential",
        },
      },
      host,
    );
    const executor = new LocalQuestionExecutor({
      agentServer: () => server,
      isAvailable: async () => true,
    });
    try {
      const handle = await executor.start(request);
      await expect(handle.completion).resolves.toMatchObject({
        status: "completed",
        answer: { body: "The initial tool environment was scoped." },
      });
      expect(submittedPrompt).not.toContain(request.credentials.token);
      expect(submittedPrompt).not.toContain("native-author-credential");
      expect(JSON.stringify(request.onCompleted.mock.calls)).not.toContain(
        request.credentials.token,
      );
    } finally {
      await executor.close();
      await server.close();
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it.each(["claude-code", "pi"] as const)(
    "gives a fresh %s terminal scoped credentials without altering shared environment",
    async (harness) => {
      const runtimeDirectory = await mkdtemp(
        path.join(tmpdir(), "question-terminal-"),
      );
      const request = question(runtimeDirectory);
      const options = {
        runtimeDirectory,
        desktopEndpoint: {
          baseUrl: request.credentials.url,
          token: "native-author-credential",
        },
      };
      const server =
        harness === "claude-code"
          ? new ClaudeAgentServer(options)
          : new PiAgentServer(options);
      const inherited = process.env.DEV_REVIEW_HOST_TOKEN;
      const executor = new LocalQuestionExecutor({
        agentServer: () => server,
        isAvailable: async () => true,
        openTerminal: async ({ session, command }) => {
          expect(command.env.DEV_REVIEW_HOST_TOKEN).toBe(
            request.credentials.token,
          );
          expect(command.env[REVIEW_AGENT_THREAD_TOKEN_ENV]).toBe(
            request.credentials.token,
          );
          expect(JSON.stringify(command.args)).not.toContain(
            request.credentials.token,
          );
          expect(command.args).not.toContain("--resume");
          expect(command.args).not.toContain("--fork");
          // Exercise the real native capture bridge, without starting a harness.
          const url =
            harness === "claude-code"
              ? command.env.DEV_FAST_REVIEW_AGENT_HOOK_URL!
              : command.env.DEV_FAST_REVIEW_AGENT_BRIDGE_URL!;
          const token =
            harness === "claude-code"
              ? command.env.DEV_FAST_REVIEW_AGENT_HOOK_TOKEN!
              : command.env.DEV_FAST_REVIEW_AGENT_BRIDGE_TOKEN!;
          const post = async (payload: JsonObject) => {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-review-token": token,
              },
              body: JSON.stringify({
                review_launch_id: command.env.DEV_FAST_REVIEW_AGENT_LAUNCH_ID,
                ...payload,
              }),
            });
            expect(response.status).toBe(200);
          };
          if (harness === "claude-code")
            await post({
              session_id: session.sessionId,
              review_event_id: randomUUID(),
              hook_event_name: "Stop",
              last_assistant_message: "A fresh Claude answer.",
            });
          else {
            await post({
              sessionId: session.sessionId,
              type: "message.updated",
              message: {
                id: randomUUID(),
                role: "assistant",
                body: "A fresh Pi answer.",
                createdAt: "2026-09-10T12:00:00Z",
              },
            });
            await post({
              sessionId: session.sessionId,
              type: "status.changed",
              status: "idle",
            });
          }
        },
      });
      try {
        const handle = await executor.start({ ...request, harness });
        expect((await handle.completion).status).toBe("completed");
        expect(process.env.DEV_REVIEW_HOST_TOKEN).toBe(inherited);
      } finally {
        await executor.close();
        await server.close();
        await rm(runtimeDirectory, { recursive: true, force: true });
      }
    },
  );
});

function question(repositoryPath: string) {
  return {
    runId: randomUUID(),
    questionId: randomUUID(),
    harness: "codex" as const,
    repositoryPath,
    context: {
      id: randomUUID(),
      reviewId: randomUUID(),
      reviewVersion: 1,
      question: "Explain the retained code.",
      material: {
        schemaVersion: 1,
        review: { title: { state: "complete", text: "Review" } },
        binding: {
          repositoryId: randomUUID(),
          baseCommit: "1".repeat(40),
          headCommit: "2".repeat(40),
        },
        mapVersions: { base: null, head: null },
        originalTarget: { kind: "document", reviewVersion: 1 },
        viewedTarget: {
          threadId: randomUUID(),
          reviewVersion: 1,
          status: "exact",
          target: { kind: "document", reviewVersion: 1 },
        },
        sourceEvidence: null,
        documentJson: { state: "complete", text: "const value = 42;" },
        priorMessages: [],
        priorMessagesOmitted: 0,
      },
    },
    credentials: {
      url: "http://127.0.0.1:4000",
      hostId: randomUUID(),
      workspaceId: randomUUID(),
      token: "private-question-test-credential",
    },
    onCompleted: vi.fn<LocalQuestionStart["onCompleted"]>(async () => {}),
  } satisfies LocalQuestionStart;
}

function scriptedCodex(
  handlers: Record<string, (params: JsonObject) => JsonValue>,
): CodexHost & { emit(notification: CodexNotification): void } {
  const listeners: ((line: string) => void)[] = [];
  const transport: Transport = {
    send(line) {
      const request = jsonObject(parseJsonText(line));
      const id = jsonNumber(request?.id);
      if (id === undefined) return;
      const method = jsonString(request?.method) ?? "";
      const params = jsonObject(request?.params) ?? {};
      const result = handlers[method]?.(params) ?? {};
      queueMicrotask(() =>
        listeners.forEach((listener) =>
          listener(JSON.stringify({ id, result })),
        ),
      );
    },
    onLine(listener) {
      listeners.push(listener);
    },
    onClose() {},
    async close() {},
  };
  const client = new CodexAppServerClient(transport);
  return {
    client: async () => client,
    url: async () => "ws://127.0.0.1:4500",
    close: async () => client.close(),
    emit(notification) {
      listeners.forEach((listener) => listener(JSON.stringify(notification)));
    },
  };
}
