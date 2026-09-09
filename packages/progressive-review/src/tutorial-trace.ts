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
    subagents: [],
    trace: {
      harness: "codex",
      title: "Checkout validation — illustrative tutorial session",
      startedAt: null,
      endedAt: null,
      activeMs: null,
      userTurns: 1,
      toolCalls: 0,
      events: [
        {
          kind: "user",
          text: "Reject invalid item quantities and missing payment tokens before creating an order.",
        },
        {
          kind: "assistant",
          markdown:
            "Validate inventory before charging the customer. This keeps an invalid quantity from reaching payment or creating a pending order.",
        },
        {
          kind: "assistant",
          markdown:
            "The sample change adds quantity validation in InventoryService and rejects an empty payment token in PaymentGateway. The order service already calls both before inserting the order.",
        },
      ],
    },
  };
}
