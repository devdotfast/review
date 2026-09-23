import type { WhiteboardAgentTraceResponse } from "@dev.fast/whiteboard-protocol";

/** Adapt retained JSON to the existing trace viewer without inventing provenance. */
export function retainedTrace(
  id: string,
  trace: { label: string; events: { role: string; text: string }[] },
): Extract<WhiteboardAgentTraceResponse, { ok: true }> {
  return {
    ok: true,
    parserVersion: "review-api-v1",
    session: {
      sessionId: id,
      title: trace.label,
      harness: "unknown",
      available: true,
      source: null,
      commits: [],
    },
    title: trace.label,
    subagents: [],
    startedAt: null,
    endedAt: null,
    activeMs: null,
    userTurns: trace.events.filter((event) => event.role === "user").length,
    toolCalls: trace.events.filter((event) => event.role === "tool").length,
    events: trace.events.map((event) =>
      event.role === "user"
        ? { kind: "user", text: event.text }
        : event.role === "assistant"
          ? { kind: "assistant", markdown: event.text }
          : {
              kind: "tool",
              tool: "unknown",
              verb: "output",
              title: "Retained tool output",
              output: event.text,
            },
    ),
  };
}
