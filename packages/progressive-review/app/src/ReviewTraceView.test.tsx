// @vitest-environment jsdom

import type {
  ReviewAgentTraceListResponse,
  ReviewAgentTraceResponse,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ReviewFetch, ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { ReviewTraceView } from "./ReviewTraceView";

const mockListResponse: Extract<ReviewAgentTraceListResponse, { ok: true }> = {
  ok: true,
  configured: true,
  sessions: [
    {
      sessionId: "session-1",
      harness: "unknown",
      available: true,
      source: "r2",
      commits: [{ sha: "commit-1", subject: "Initial commit subject" }],
      subagents: ["sub-1"],
    },
  ],
};

const mockTraceDetail: Extract<ReviewAgentTraceResponse, { ok: true }> = {
  ok: true,
  parserVersion: "1.0",
  session: {
    sessionId: "session-1",
    harness: "pi",
    available: true,
    source: "r2",
    commits: [{ sha: "commit-1", subject: "Initial commit subject" }],
  },
  title: "Upgraded Trace Title",
  subagents: ["sub-1"],
  startedAt: "2025-01-01T00:00:00Z",
  endedAt: "2025-01-01T00:01:00Z",
  activeMs: 60000,
  userTurns: 1,
  toolCalls: 1,
  events: [
    {
      kind: "user",
      text: "User turn text",
      at: "2025-01-01T00:00:00Z",
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement;

describe("ReviewTraceView", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads session list and active trace detail without getting stuck in loading state", async () => {
    const requestMock = vi.fn<ReviewFetch>().mockImplementation((url) => {
      if (url.includes("/agent-traces/session-1")) {
        return Promise.resolve(
          new Response(JSON.stringify(mockTraceDetail), { status: 200 }),
        );
      }
      if (url.includes("/agent-traces")) {
        return Promise.resolve(
          new Response(JSON.stringify(mockListResponse), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const session = testReviewSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <ReviewSessionProvider session={session}>
          <ReviewTraceView />
        </ReviewSessionProvider>,
      );
    });

    // Wait for microtasks
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Should display the trace title and content, not "Loading trace…"
    expect(container.textContent).toContain("Upgraded Trace Title");
    expect(container.textContent).toContain("User turn text");
    expect(container.textContent).not.toContain("Loading trace…");
  });

  it("shows unconfigured state when list returns configured: false", async () => {
    const unconfiguredList: Extract<
      ReviewAgentTraceListResponse,
      { ok: true }
    > = {
      ok: true,
      configured: false,
      sessions: [],
    };

    const requestMock = vi.fn<ReviewFetch>().mockImplementation((url) => {
      if (url.includes("/agent-traces")) {
        return Promise.resolve(
          new Response(JSON.stringify(unconfiguredList), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const session = testReviewSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <ReviewSessionProvider session={session}>
          <ReviewTraceView />
        </ReviewSessionProvider>,
      );
    });

    expect(container.textContent).toContain("Agent traces are not configured");
  });

  it("renders thinking events collapsed by default under a Thinking tool section", async () => {
    const traceWithThinking: Extract<ReviewAgentTraceResponse, { ok: true }> = {
      ok: true,
      parserVersion: "1.0",
      session: {
        sessionId: "session-1",
        harness: "pi",
        available: true,
        source: "r2",
        commits: [{ sha: "commit-1", subject: "Initial commit subject" }],
      },
      title: "Trace with Thinking",
      subagents: [],
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: "2025-01-01T00:01:00Z",
      activeMs: 60000,
      userTurns: 1,
      toolCalls: 1,
      events: [
        {
          kind: "user",
          text: "What is the plan?",
          at: "2025-01-01T00:00:00Z",
        },
        {
          kind: "assistant",
          thinking: true,
          markdown: "Let me think about how to solve this problem...",
          at: "2025-01-01T00:00:05Z",
        },
        {
          kind: "tool",
          tool: "bash",
          verb: "Ran",
          title: "pnpm test",
          command: "pnpm test",
          output: "All tests pass",
          at: "2025-01-01T00:00:10Z",
        },
        {
          kind: "assistant",
          thinking: false,
          markdown: "Here is the result.",
          at: "2025-01-01T00:00:15Z",
        },
      ],
    };

    const requestMock = vi.fn<ReviewFetch>().mockImplementation((url) => {
      if (url.includes("/agent-traces/session-1")) {
        return Promise.resolve(
          new Response(JSON.stringify(traceWithThinking), { status: 200 }),
        );
      }
      if (url.includes("/agent-traces")) {
        return Promise.resolve(
          new Response(JSON.stringify(mockListResponse), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const session = testReviewSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <ReviewSessionProvider session={session}>
          <ReviewTraceView />
        </ReviewSessionProvider>,
      );
    });

    // Wait for microtasks
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Expand the turn's worked section
    const workedDetails = container.querySelector(
      "details.review-trace-worked",
    ) as HTMLDetailsElement;
    expect(workedDetails).not.toBeNull();
    act(() => {
      workedDetails.open = true;
    });

    // Find the thinking details element
    const thinkingDetails = Array.from(
      container.querySelectorAll("details.review-trace-tool--expandable"),
    ).find(
      (el) =>
        el.querySelector(".review-trace-tool-verb")?.textContent === "Thinking",
    ) as HTMLDetailsElement | undefined;

    expect(thinkingDetails).toBeDefined();
    // Should be collapsed by default
    expect(thinkingDetails?.open).toBe(false);
    expect(
      thinkingDetails?.querySelector(".review-trace-tool-verb")?.textContent,
    ).toBe("Thinking");
    expect(
      thinkingDetails?.querySelector(".review-trace-figure-head")?.textContent,
    ).toBe("Thinking");
    expect(
      thinkingDetails?.querySelector(".review-trace-figure-body--thinking")
        ?.textContent,
    ).toContain("Let me think about how to solve this problem...");
  });
});
