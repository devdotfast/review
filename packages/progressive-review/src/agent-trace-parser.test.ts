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

    it("sniffs opencode harness from the session header", () => {
      const chunk = JSON.stringify({ type: "opencode_session", id: "ses_1" });
      expect(sniffAgentTraceHarness(chunk)).toBe("opencode");
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
  });

  describe("OpenCode sessions", () => {
    it("parses the header, user turns, reasoning, tools, and compaction", () => {
      const jsonl = [
        JSON.stringify({
          type: "opencode_session",
          id: "ses_1",
          directory: "/repo",
          title: "Fix the flaky test",
          time: { created: 1_788_000_000_000 },
        }),
        JSON.stringify({
          type: "opencode_message",
          info: { role: "user", time: { created: 1_788_000_001_000 } },
          parts: [
            { type: "text", text: "<skill>injected</skill>", synthetic: true },
            { type: "text", text: "Fix the flaky test" },
          ],
        }),
        JSON.stringify({
          type: "opencode_message",
          info: {
            role: "assistant",
            time: { created: 1_788_000_002_000, completed: 1_788_000_010_000 },
          },
          parts: [
            { type: "step-start" },
            {
              type: "reasoning",
              text: "Look at the test first.",
              time: { start: 1_788_000_003_000 },
            },
            {
              type: "tool",
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: "/repo/src/db.test.ts" },
                output: "describe('db', () => {})",
                time: { start: 1_788_000_004_000 },
              },
            },
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                input: { command: "pnpm test" },
                error: "exit 1",
                time: { start: 1_788_000_005_000 },
              },
            },
            {
              type: "tool",
              tool: "apply_patch",
              state: {
                status: "completed",
                input: {
                  patchText:
                    "*** Begin Patch\n*** Update File: /repo/src/db.ts\n@@\n-a\n+b\n+c\n*** End Patch",
                },
                output: "Done",
                time: { start: 1_788_000_006_000 },
              },
            },
            { type: "compaction", auto: true },
            { type: "text", text: "Fixed." },
            { type: "step-finish" },
          ],
        }),
      ].join("\n");

      const result = parseAgentTraceJsonl(jsonl);
      expect(result.harness).toBe("opencode");
      expect(result.title).toBe("Fix the flaky test");
      expect(result.startedAt).toBe("2026-08-29T10:40:00.000Z");
      expect(result.endedAt).toBe("2026-08-29T10:40:10.000Z");
      expect(result.userTurns).toBe(1);
      expect(result.toolCalls).toBe(3);
      expect(result.events).toEqual([
        {
          kind: "user",
          text: "Fix the flaky test",
          at: "2026-08-29T10:40:01.000Z",
        },
        {
          kind: "assistant",
          markdown: "Look at the test first.",
          thinking: true,
          at: "2026-08-29T10:40:03.000Z",
        },
        {
          kind: "tool",
          tool: "read",
          verb: "Read",
          title: "src/db.test.ts",
          filePath: "src/db.test.ts",
          input: '{"filePath":"/repo/src/db.test.ts"}',
          output: "describe('db', () => {})",
          at: "2026-08-29T10:40:04.000Z",
        },
        {
          kind: "tool",
          tool: "bash",
          verb: "Ran",
          title: "pnpm test",
          command: "pnpm test",
          output: "exit 1",
          at: "2026-08-29T10:40:05.000Z",
        },
        {
          kind: "tool",
          tool: "apply_patch",
          verb: "Edited",
          title: "src/db.ts",
          filePath: "src/db.ts",
          additions: 2,
          deletions: 1,
          input: expect.stringContaining("Update File"),
          output: "Done",
          at: "2026-08-29T10:40:06.000Z",
        },
        { kind: "separator", label: "Context compacted" },
        {
          kind: "assistant",
          markdown: "Fixed.",
          at: "2026-08-29T10:40:02.000Z",
        },
      ]);
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
