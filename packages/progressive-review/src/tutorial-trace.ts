import { AGENT_TRACE_PARSER_VERSION } from "./agent-trace-parser";
import type { LoadedReviewAgentTrace } from "./review-agent-traces";

// Reserved sample ID: the tutorial works offline without trace capture setup.
export const TUTORIAL_TRACE_SESSION_ID = "review-tutorial-checkout";

export function loadTutorialTrace(): LoadedReviewAgentTrace {
  return {
    parserVersion: AGENT_TRACE_PARSER_VERSION,
    descriptor: {
      sessionId: TUTORIAL_TRACE_SESSION_ID,
      harness: "codex",
      available: true,
      source: null,
      subagents: [],
      commits: [],
    },
    traceName: null,
    // Bundled with the app; there is no store to confirm it against.
    cacheStatus: "current",
    subagents: [],
    trace: {
      harness: "codex",
      title: "Shared agent chat server — illustrative tutorial session",
      startedAt: null,
      endedAt: null,
      activeMs: null,
      userTurns: 1,
      toolCalls: 0,
      events: [
        {
          kind: "user",
          text: "Right now, each Review window manages its own agent chats, so opening the same thread in another window can show stale messages or start a duplicate session. I think we want to have one shared server / source of truth for all agent chats. Can you move session ownership and message history into the server, and have each window subscribe to updates? Closing a window should not end the conversation. Keep the existing chat UI, and make sure reconnecting shows the messages that arrived while the window was closed.",
        },
        {
          kind: "assistant",
          markdown:
            "I'll make the server own each thread's agent session and message history. Windows will read that history and subscribe to new messages, so opening a thread in two windows attaches both to the same conversation.",
        },
        {
          kind: "assistant",
          markdown:
            "Closing a window will detach its subscription without stopping the agent session. On reconnect, the window will catch up from the server's stored history before displaying live updates. I'll also check that simultaneous requests to open the same thread cannot create duplicate sessions.",
        },
      ],
    },
  };
}
