// @vitest-environment jsdom

import type {
  ReviewAgentTraceResponse,
  ReviewCanvasBridge,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import {
  type AgentTraceState,
  type LoadedAgentTrace,
  clearAgentTraceCache,
  makeAgentTraceKey,
  makeAgentTraceUrl,
  useAgentTrace,
} from "./use-agent-trace";

const mockTraceData: Extract<ReviewAgentTraceResponse, { ok: true }> = {
  ok: true,
  parserVersion: "1.0",
  session: {
    sessionId: "session-123",
    harness: "pi",
    available: true,
    source: "r2",
    commits: [{ sha: "abc1234", subject: "Initial commit" }],
  },
  title: "Test Trace Title",
  subagents: [],
  startedAt: "2025-01-01T00:00:00Z",
  endedAt: "2025-01-01T00:01:00Z",
  activeMs: 60000,
  userTurns: 1,
  toolCalls: 2,
  events: [
    {
      kind: "user",
      text: "Hello agent",
      at: "2025-01-01T00:00:00Z",
    },
  ],
};

let root: Root | null = null;
let root2: Root | null = null;
let container: HTMLDivElement;
let container2: HTMLDivElement;

describe("useAgentTrace", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    clearAgentTraceCache();
    container = document.createElement("div");
    container2 = document.createElement("div");
    document.body.append(container, container2);
    root = createRoot(container);
    root2 = createRoot(container2);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    if (root2) {
      await act(async () => root2?.unmount());
      root2 = null;
    }
    document.body.replaceChildren();
    clearAgentTraceCache();
    vi.restoreAllMocks();
  });

  describe("makeAgentTraceKey & makeAgentTraceUrl", () => {
    it("builds correct key without trace param", () => {
      expect(makeAgentTraceKey("session-abc")).toBe("session-abc");
    });

    it("builds correct key with trace param", () => {
      expect(makeAgentTraceKey("session-abc", "subagent-1")).toBe(
        "session-abc:subagent-1",
      );
    });

    it("builds URL with query parameter encoding", () => {
      expect(makeAgentTraceUrl("session-abc")).toBe(
        "/agent-traces/session-abc",
      );
      expect(makeAgentTraceUrl("session-abc", "sub/agent#1")).toBe(
        "/agent-traces/session-abc?trace=sub%2Fagent%231",
      );
    });
  });

  describe("hook lifecycle and state machine", () => {
    it("returns idle status when sessionId is missing", () => {
      let latestState: unknown;
      function TestComponent() {
        latestState = useAgentTrace(undefined);
        return <div>idle</div>;
      }

      const session = testReviewSession();
      act(() => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });

      expect(latestState).toEqual({ status: "idle" });
    });

    it("loads trace successfully and transitions to loaded state", async () => {
      let latestState: unknown;
      function TestComponent({ sessionId }: { sessionId: string }) {
        latestState = useAgentTrace(sessionId);
        return <div>test</div>;
      }

      let fetchSignal: AbortSignal | undefined;
      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation((_url, init) => {
          fetchSignal = init?.signal ?? undefined;
          return Promise.resolve(
            new Response(JSON.stringify(mockTraceData), { status: 200 }),
          );
        });

      const session = testReviewSession({}, { request: requestMock });

      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent sessionId="session-123" />
          </ReviewSessionProvider>,
        );
      });

      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("/agent-traces/session-123"),
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      expect(fetchSignal?.aborted).toBe(false);
      expect(latestState).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });
    });

    it("handles fetch errors and transitions to error state", async () => {
      let latestState: unknown;
      function TestComponent({ sessionId }: { sessionId: string }) {
        latestState = useAgentTrace(sessionId);
        return <div>test</div>;
      }

      const errorPayload = { ok: false, error: "Trace not found in R2" };
      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify(errorPayload), { status: 404 }),
          ),
        );

      const session = testReviewSession({}, { request: requestMock });

      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent sessionId="session-404" />
          </ReviewSessionProvider>,
        );
      });

      expect(latestState).toEqual({
        status: "error",
        error: "Trace not found in R2",
      });
    });

    it("uses cached response on subsequent mounts without refetching", async () => {
      let latestState: unknown;
      function TestComponent({ sessionId }: { sessionId: string }) {
        latestState = useAgentTrace(sessionId);
        return <div>{JSON.stringify(latestState)}</div>;
      }

      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify(mockTraceData), { status: 200 }),
          ),
        );

      const session = testReviewSession({}, { request: requestMock });

      // First mount
      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent sessionId="session-123" />
          </ReviewSessionProvider>,
        );
      });

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(latestState).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });

      // Unmount first component
      await act(async () => {
        root?.unmount();
        root = createRoot(container);
      });

      // Second mount with same session ID
      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent sessionId="session-123" />
          </ReviewSessionProvider>,
        );
      });

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(latestState).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });
    });

    it("does not reuse a trace from another Review session", async () => {
      let latestState: AgentTraceState | undefined;
      function TestComponent() {
        latestState = useAgentTrace("session-123");
        return <div>test</div>;
      }

      const firstRequest = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockResolvedValue(
          new Response(JSON.stringify(mockTraceData), { status: 200 }),
        );
      const firstSession = testReviewSession({}, { request: firstRequest });

      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={firstSession}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });
      await act(async () => {
        root?.unmount();
        root = createRoot(container);
      });

      const refreshedTrace: LoadedAgentTrace = {
        ...mockTraceData,
        events: [...mockTraceData.events, { kind: "user", text: "New prompt" }],
      };
      const secondRequest = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockResolvedValue(
          new Response(JSON.stringify(refreshedTrace), { status: 200 }),
        );
      const secondSession = testReviewSession({}, { request: secondRequest });

      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={secondSession}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });

      expect(firstRequest).toHaveBeenCalledTimes(1);
      expect(secondRequest).toHaveBeenCalledTimes(1);
      expect(latestState).toEqual({
        status: "loaded",
        trace: refreshedTrace,
      });
    });

    it("refetches after its Review session cache is cleared", async () => {
      let latestState: AgentTraceState | undefined;
      function TestComponent() {
        latestState = useAgentTrace("session-123");
        return <div>test</div>;
      }

      const refreshedTrace: LoadedAgentTrace = {
        ...mockTraceData,
        events: [...mockTraceData.events, { kind: "user", text: "New prompt" }],
      };
      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockTraceData), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(refreshedTrace), { status: 200 }),
        );
      const session = testReviewSession({}, { request: requestMock });

      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });
      await act(async () => {
        root?.unmount();
        root = createRoot(container);
      });

      clearAgentTraceCache(session);
      await act(async () => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });

      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(latestState).toEqual({
        status: "loaded",
        trace: refreshedTrace,
      });
    });

    it("deduplicates in-flight requests across concurrent consumers", async () => {
      let state1: unknown;
      let state2: unknown;
      function Consumer1() {
        state1 = useAgentTrace("shared-session", "subagent-a");
        return <div>C1</div>;
      }
      function Consumer2() {
        state2 = useAgentTrace("shared-session", "subagent-a");
        return <div>C2</div>;
      }

      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation(() => fetchPromise);
      const session = testReviewSession({}, { request: requestMock });

      // Mount both consumers concurrently
      act(() => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <Consumer1 />
          </ReviewSessionProvider>,
        );
        root2?.render(
          <ReviewSessionProvider session={session}>
            <Consumer2 />
          </ReviewSessionProvider>,
        );
      });

      // Both should be in loading state, and only 1 network fetch triggered
      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(state1).toEqual({ status: "loading" });
      expect(state2).toEqual({ status: "loading" });

      // Resolve the single in-flight fetch
      await act(async () => {
        resolveFetch(
          new Response(JSON.stringify(mockTraceData), { status: 200 }),
        );
        await fetchPromise;
      });

      // Both should be loaded with the same result
      expect(state1).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });
      expect(state2).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });
    });

    it("aborts in-flight request when sole consumer unmounts", async () => {
      function TestComponent() {
        useAgentTrace("abort-session");
        return <div>loading</div>;
      }

      let capturedSignal: AbortSignal | undefined;
      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation((_url, init) => {
          capturedSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {
            // never resolves
          });
        });

      const session = testReviewSession({}, { request: requestMock });

      act(() => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <TestComponent />
          </ReviewSessionProvider>,
        );
      });

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      // Unmount the component
      act(() => {
        root?.unmount();
        root = null;
      });

      expect(capturedSignal?.aborted).toBe(true);
    });

    it("does not abort shared in-flight fetch if another consumer is still mounted", async () => {
      let state2: unknown;
      function Consumer1() {
        useAgentTrace("shared-abort-session");
        return <div>C1</div>;
      }
      function Consumer2() {
        state2 = useAgentTrace("shared-abort-session");
        return <div>C2</div>;
      }

      let capturedSignal: AbortSignal | undefined;
      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const requestMock = vi
        .fn<ReviewCanvasBridge["request"]>()
        .mockImplementation((_url, init) => {
          capturedSignal = init?.signal ?? undefined;
          return fetchPromise;
        });

      const session = testReviewSession({}, { request: requestMock });

      act(() => {
        root?.render(
          <ReviewSessionProvider session={session}>
            <Consumer1 />
          </ReviewSessionProvider>,
        );
        root2?.render(
          <ReviewSessionProvider session={session}>
            <Consumer2 />
          </ReviewSessionProvider>,
        );
      });

      expect(capturedSignal?.aborted).toBe(false);

      // Unmount Consumer 1
      act(() => {
        root?.unmount();
        root = null;
      });

      // Signal must NOT be aborted because Consumer 2 is still mounted
      expect(capturedSignal?.aborted).toBe(false);

      // Complete fetch
      await act(async () => {
        resolveFetch(
          new Response(JSON.stringify(mockTraceData), { status: 200 }),
        );
        await fetchPromise;
      });

      // Consumer 2 receives the result
      expect(state2).toEqual({
        status: "loaded",
        trace: mockTraceData,
      });
    });
  });
});
