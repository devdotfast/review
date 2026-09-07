import { describe, expect, it } from "vitest";

import {
  AGENT_TRACE_PARSER_VERSION,
  parseAgentTraceJsonl,
  sniffAgentTraceHarness,
} from "./agent-trace-parser";

describe("agent-trace-parser", () => {
  it("exports the parser version", () => {
    expect(AGENT_TRACE_PARSER_VERSION).toBe("1");
  });

  describe("sniffAgentTraceHarness", () => {
    it("sniffs codex harness from session_meta", () => {
      const chunk = JSON.stringify({
        type: "session_meta",
        payload: { id: "123" },
      });
      expect(sniffAgentTraceHarness(chunk)).toBe("codex");
    });

    it("sniffs pi harness from session", () => {
      const chunk = JSON.stringify({ type: "session", id: "123" });
      expect(sniffAgentTraceHarness(chunk)).toBe("pi");
    });

    it("sniffs claude-code harness from first claude record", () => {
      const chunk = JSON.stringify({ type: "ai-title", aiTitle: "Fix bug" });
      expect(sniffAgentTraceHarness(chunk)).toBe("claude-code");
    });
  });

  describe("Claude Code transcripts", () => {
    it("parses user turns, thinking blocks, assistant prose, and tool calls", () => {
      const jsonl = [
        JSON.stringify({ type: "ai-title", aiTitle: "Fix memory leak" }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-16T12:00:00Z",
          message: {
            content: [{ type: "text", text: "Please investigate the leak." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-16T12:01:00Z",
          message: {
            content: [
              { type: "thinking", thinking: "I need to check allocations." },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: { command: "rg 'leak' src/" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-16T12:01:10Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [{ type: "text", text: "src/leak.ts:10" }],
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-16T12:02:00Z",
          message: {
            content: [
              { type: "text", text: "I found the leak in `src/leak.ts`." },
            ],
          },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("claude-code");
      expect(result.title).toBe("Fix memory leak");
      expect(result.userTurns).toBe(1);
      expect(result.toolCalls).toBe(1);
      expect(result.events).toHaveLength(4);

      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Please investigate the leak.",
        at: "2026-08-16T12:00:00Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "I need to check allocations.",
        thinking: true,
        at: "2026-08-16T12:01:00Z",
      });
      expect(result.events[2]).toEqual({
        kind: "tool",
        tool: "Bash",
        verb: "Ran",
        title: "rg 'leak' src/",
        command: "rg 'leak' src/",
        output: "src/leak.ts:10",
        at: "2026-08-16T12:01:00Z",
      });
      expect(result.events[3]).toEqual({
        kind: "assistant",
        markdown: "I found the leak in `src/leak.ts`.",
        at: "2026-08-16T12:02:00Z",
      });
    });

    it("filters out sidechain records for main trace unless isSubagent is true", () => {
      const jsonl = [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-16T12:00:00Z",
          message: { content: [{ type: "text", text: "Main turn" }] },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          timestamp: "2026-08-16T12:00:30Z",
          message: { content: [{ type: "text", text: "Subagent turn" }] },
        }),
      ].join("\n");

      const mainResult = parseAgentTraceJsonl(jsonl);
      expect(mainResult.events).toHaveLength(1);
      expect(mainResult.events[0].kind).toBe("user");
      expect((mainResult.events[0] as any).text).toBe("Main turn");

      const subResult = parseAgentTraceJsonl(jsonl, { isSubagent: true });
      expect(subResult.events).toHaveLength(2);
    });
  });

  describe("Codex transcripts", () => {
    it("parses event_msg user_message, agent_message, and patch_apply_end", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/repo", timestamp: "2026-08-16T10:00:00Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-16T10:00:05Z",
          payload: {
            type: "user_message",
            message: "Refactor database queries",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-16T10:01:00Z",
          payload: {
            type: "patch_apply_end",
            changes: {
              "/repo/src/db.ts": {
                type: "edit",
                unified_diff:
                  "--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
              },
            },
            stdout: "Success",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-16T10:02:00Z",
          payload: {
            type: "agent_message",
            message: "Refactoring complete.",
          },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("codex");
      expect(result.title).toBe("Refactor database queries");
      expect(result.userTurns).toBe(1);
      expect(result.toolCalls).toBe(1);
      expect(result.events).toHaveLength(3);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Refactor database queries",
        at: "2026-08-16T10:00:05Z",
      });
      expect(result.events[1]).toMatchObject({
        kind: "tool",
        tool: "apply_patch",
        verb: "Edited",
        filePath: "src/db.ts",
        additions: 1,
        deletions: 1,
      });
      expect(result.events[2]).toEqual({
        kind: "assistant",
        markdown: "Refactoring complete.",
        at: "2026-08-16T10:02:00Z",
      });
    });

    it("derives the title from the first response_item user message", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: {
            cwd: "/repo",
            id: "s1",
            timestamp: "2026-09-01T10:00:00Z",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:05Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Refactor the database module" },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:30Z",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [
              { type: "output_text", text: "I'll start by reading the files." },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:01:00Z",
          payload: {
            type: "exec_command_end",
            command: ["rg", "db", "src"],
            aggregated_output: "src/db.ts",
            exit_code: 0,
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:02:00Z",
          payload: { type: "task_complete", turn_id: "t1" },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("codex");
      expect(result.title).toBe("Refactor the database module");
      expect(result.userTurns).toBe(1);
      expect(result.toolCalls).toBe(1);
      expect(result.events).toHaveLength(3);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Refactor the database module",
        at: "2026-09-01T10:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "I'll start by reading the files.",
        at: "2026-09-01T10:00:30Z",
      });
      expect(result.events[2]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Ran",
        title: "rg db src",
      });
    });

    it("keeps a response_item user turn when assistant turns arrive via event_msg agent_message", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: {
            cwd: "/repo",
            id: "s2",
            timestamp: "2026-09-01T10:00:00Z",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:05Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the leak" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:01:00Z",
          payload: { type: "agent_message", message: "Done." },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("codex");
      expect(result.title).toBe("Fix the leak");
      expect(result.userTurns).toBe(1);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Fix the leak",
        at: "2026-09-01T10:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "Done.",
        at: "2026-09-01T10:01:00Z",
      });
    });

    it("does not double-emit user turns when both event_msg user_message and response_item user messages exist", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/repo", timestamp: "2026-09-01T10:00:00Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:00:05Z",
          payload: {
            type: "user_message",
            message: "Refactor database queries",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:10Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Refactor database queries (dup)" },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:01:00Z",
          payload: { type: "agent_message", message: "Refactoring complete." },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.userTurns).toBe(1);
      expect(result.title).toBe("Refactor database queries");
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Refactor database queries",
        at: "2026-09-01T10:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "Refactoring complete.",
        at: "2026-09-01T10:01:00Z",
      });
    });

    it("does not double-emit assistant turns when both event_msg agent_message and response_item assistant messages exist", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/repo", timestamp: "2026-09-01T10:00:00Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:00:05Z",
          payload: {
            type: "user_message",
            message: "Refactor database queries",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:30Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Duplicate assistant text." },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:01:00Z",
          payload: { type: "agent_message", message: "Refactoring complete." },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.userTurns).toBe(1);
      expect(result.title).toBe("Refactor database queries");
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Refactor database queries",
        at: "2026-09-01T10:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "Refactoring complete.",
        at: "2026-09-01T10:01:00Z",
      });
    });

    it("emits a response_item assistant turn when no event_msg agent_message exists", () => {
      const jsonl = [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/repo", timestamp: "2026-09-01T10:00:00Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-01T10:00:05Z",
          payload: { type: "user_message", message: "Summarize the plan" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-01T10:00:30Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Here is the plan." }],
          },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.userTurns).toBe(1);
      expect(result.title).toBe("Summarize the plan");
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Summarize the plan",
        at: "2026-09-01T10:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "Here is the plan.",
        at: "2026-09-01T10:00:30Z",
      });
    });
  });

  describe("Pi transcripts", () => {
    it("parses session, user turns, assistant with thinking, and tools", () => {
      const jsonl = [
        JSON.stringify({
          type: "session",
          id: "pi-session-1",
          cwd: "/repo",
          timestamp: "2026-08-16T14:00:00Z",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-16T14:00:05Z",
          message: {
            role: "user",
            content: "Add unit tests",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-16T14:01:00Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I will read existing tests." },
              {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "src/db.test.ts" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-16T14:01:05Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            content: "describe('db', () => {})",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-16T14:02:00Z",
          message: {
            role: "assistant",
            content: "Added tests for db module.",
          },
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("pi");
      expect(result.userTurns).toBe(1);
      expect(result.toolCalls).toBe(1);
      expect(result.events).toHaveLength(4);

      expect(result.events[0]).toEqual({
        kind: "user",
        text: "Add unit tests",
        at: "2026-08-16T14:00:05Z",
      });
      expect(result.events[1]).toEqual({
        kind: "assistant",
        markdown: "I will read existing tests.",
        thinking: true,
        at: "2026-08-16T14:01:00Z",
      });
      expect(result.events[2]).toMatchObject({
        kind: "tool",
        tool: "read",
        verb: "Read",
        title: "src/db.test.ts",
        filePath: "src/db.test.ts",
        output: "describe('db', () => {})",
        at: "2026-08-16T14:01:00Z",
      });
      expect(result.events[3]).toEqual({
        kind: "assistant",
        markdown: "Added tests for db module.",
        at: "2026-08-16T14:02:00Z",
      });
    });
  });
});
