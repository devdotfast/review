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

    const codexExecJsonl = (argumentsText: string): string => {
      const callId = "call-exec";
      return [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/repo", timestamp: "2026-08-16T10:00:00Z" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-16T10:00:05Z",
          payload: {
            type: "function_call",
            name: "exec",
            call_id: callId,
            arguments: argumentsText,
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-16T10:00:06Z",
          payload: {
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          },
        }),
      ].join("\n");
    };

    it("surfaces exec command-field events whose args contain a bare 'tools.' substring", () => {
      const control = parseAgentTraceJsonl(
        codexExecJsonl(
          JSON.stringify({ command: ["grep", "-n", "export", "src/util.ts"] }),
        ),
      );
      expect(control.toolCalls).toBe(1);
      expect(control.events).toHaveLength(1);
      expect(control.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Ran",
        title: "grep -n export src/util.ts",
        command: "grep -n export src/util.ts",
        output: "ok",
      });

      const toolsPath = parseAgentTraceJsonl(
        codexExecJsonl(
          JSON.stringify({
            command: ["grep", "-n", "export", "src/tools.config.ts"],
          }),
        ),
      );
      expect(toolsPath.toolCalls).toBe(1);
      expect(toolsPath.events).toHaveLength(1);
      expect(toolsPath.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Ran",
        command: "grep -n export src/tools.config.ts",
      });

      const toolsPattern = parseAgentTraceJsonl(
        codexExecJsonl(JSON.stringify({ command: "rg -n tools. src/" })),
      );
      expect(toolsPattern.toolCalls).toBe(1);
      expect(toolsPattern.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Ran",
        command: "rg -n tools. src/",
      });
    });

    it("routes code-mode tools.<name>( dispatches to Called and skips wait/mcp__", () => {
      const called = parseAgentTraceJsonl(
        codexExecJsonl(JSON.stringify({ blob: "tools.run(foo)" })),
      );
      expect(called.toolCalls).toBe(1);
      expect(called.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Called",
        title: "run",
      });

      const wait = parseAgentTraceJsonl(
        codexExecJsonl(JSON.stringify({ blob: "tools.wait(123)" })),
      );
      expect(wait.toolCalls).toBe(0);
      expect(wait.events).toHaveLength(0);

      const mcp = parseAgentTraceJsonl(
        codexExecJsonl(JSON.stringify({ blob: "tools.mcp__server(arg)" })),
      );
      expect(mcp.toolCalls).toBe(0);
      expect(mcp.events).toHaveLength(0);
    });

    it("routes *** Add|Update|Delete File: patch blobs to Edited and respects skipPatches", () => {
      const patchBlob =
        "*** Add File: src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-old\n+new";

      const edited = parseAgentTraceJsonl(codexExecJsonl(patchBlob));
      expect(edited.toolCalls).toBe(1);
      expect(edited.events).toHaveLength(1);
      expect(edited.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Edited",
        filePath: "src/db.ts",
      });

      const suppressible = parseAgentTraceJsonl(
        [
          JSON.stringify({
            type: "session_meta",
            payload: { cwd: "/repo", timestamp: "2026-08-16T10:00:00Z" },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-08-16T10:00:05Z",
            payload: {
              type: "patch_apply_end",
              changes: {
                "/repo/src/other.ts": {
                  type: "edit",
                  unified_diff:
                    "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b",
                },
              },
              stdout: "Success",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-08-16T10:00:06Z",
            payload: {
              type: "function_call",
              name: "exec",
              call_id: "call-exec",
              arguments: patchBlob,
            },
          }),
        ].join("\n"),
      );
      expect(suppressible.toolCalls).toBe(1);
      expect(suppressible.events).toHaveLength(1);
      expect(suppressible.events[0]).toMatchObject({
        kind: "tool",
        tool: "apply_patch",
        verb: "Edited",
        filePath: "src/other.ts",
      });
    });

    it("does not divert a command field that merely greps for the literal '*** Add File:' marker", () => {
      const result = parseAgentTraceJsonl(
        codexExecJsonl(
          JSON.stringify({ command: ["grep", "*** Add File:", "src/"] }),
        ),
      );
      expect(result.toolCalls).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        kind: "tool",
        tool: "exec",
        verb: "Ran",
        command: "grep *** Add File: src/",
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
