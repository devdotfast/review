import type {
  WhiteboardAgentTraceListResponse,
  WhiteboardAgentTraceResponse,
  WhiteboardCanvasBridge,
} from "@dev.fast/whiteboard-protocol";
import { act, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WhiteboardSessionProvider,
  createWhiteboardSession,
} from "./host/whiteboard-session";
import { useTraceList } from "./use-trace-list";
import {
  testWhiteboardBridge,
  testWhiteboardSession,
} from "./whiteboard-session-test-utils";
import { WhiteboardTraceView } from "./WhiteboardTraceView";

const mockListResponse: Extract<
  WhiteboardAgentTraceListResponse,
  { ok: true }
> = {
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

const mockTraceDetail: Extract<WhiteboardAgentTraceResponse, { ok: true }> = {
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

describe("WhiteboardTraceView", () => {
  beforeEach(() => {
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

  it("shares an in-flight listing with the Trace view and reuses it after reopening", async () => {
    const pending = Promise.withResolvers<Response>();

    const request = vi.fn<WhiteboardCanvasBridge["request"]>((url) =>
      url.includes("/agent-traces/session-1")
        ? Promise.resolve(Response.json(mockTraceDetail))
        : pending.promise,
    );

    const session = testWhiteboardSession({}, { request });

    function Host() {
      const list = useTraceList();
      const [open, setOpen] = useState(false);

      return (
        <>
          <button onClick={() => setOpen(!open)}>Toggle trace</button>
          {open && <WhiteboardTraceView storedList={list} />}
        </>
      );
    }

    await act(async () =>
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <Host />
        </WhiteboardSessionProvider>,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Resolving agent sessions");
    await act(async () => pending.resolve(Response.json(mockListResponse)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("User turn text"),
    );
    await act(async () => container.querySelector("button")!.click());
    await act(async () => container.querySelector("button")!.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("User turn text"),
    );
    expect(
      request.mock.calls.filter(
        ([url]) => !String(url).includes("/agent-traces/session-1"),
      ),
    ).toHaveLength(1);
  });

  it("renders retained subagent events without downloading them", async () => {
    const request = vi.fn<WhiteboardCanvasBridge["request"]>(async () => {
      throw new Error("offline");
    });

    const session = testWhiteboardSession({}, { request });

    const retained = {
      ...mockTraceDetail,
      session: { ...mockTraceDetail.session, subagents: ["sub-1"] },
    };

    session.review!.traces = new Map([
      ["session-1", retained],
      [
        "session-1:sub-1",
        {
          ...retained,
          events: [{ kind: "user", text: "Retained subagent proof" }],
        },
      ],
    ]);
    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardTraceView
            initialSelection={{ sessionId: "session-1", trace: "sub-1" }}
          />
        </WhiteboardSessionProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Retained subagent proof"),
    );
    expect(
      request.mock.calls.some(([url]) =>
        String(url).includes("/agent-traces/session-1"),
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    "loads stored traces with JSON review mode %s",
    async (jsonWhiteboard) => {
      const requestMock = vi
        .fn<WhiteboardCanvasBridge["request"]>()
        .mockImplementation((url) => {
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

      const session = jsonWhiteboard
        ? createWhiteboardSession(
            testWhiteboardBridge({}, { request: requestMock }),
            {
              jsonWhiteboard: { id: "json-review", version: () => 0 },
            },
          )
        : testWhiteboardSession({}, { request: requestMock });

      if (jsonWhiteboard)
        session.review = {
          pins: { base: "base", head: "head" },
          historicalRevision: null,
          updatedAtMs: 0,
          traces: new Map(),
          listVersions: async () => [],
          stack: async () => [],
          dismiss: async () => {},
        };

      await act(async () => {
        root?.render(
          <WhiteboardSessionProvider session={session}>
            <WhiteboardTraceView />
          </WhiteboardSessionProvider>,
        );
      });

      await vi.waitFor(() => {
        expect(container.textContent).toContain("Upgraded Trace Title");
      });

      expect(container.textContent).toContain("User turn text");
      expect(container.textContent).not.toContain("Loading trace…");
    },
  );

  it("offers a source control when two stores are readable and labels offline copies", async () => {
    const requested: string[] = [];

    const requestMock = vi
      .fn<WhiteboardCanvasBridge["request"]>()
      .mockImplementation((url) => {
        requested.push(url);

        if (url.includes("/agent-traces/session-1")) {
          const detail = {
            ...mockTraceDetail,
            cacheStatus: url.includes("storage=hosted") ? "offline" : "current",
          };

          return Promise.resolve(
            new Response(JSON.stringify(detail), { status: 200 }),
          );
        }

        if (url.includes("/agent-traces")) {
          const list = {
            ...mockListResponse,
            storage: url.includes("storage=hosted") ? "hosted" : "s3",
            sources: ["s3", "hosted"],
          };

          return Promise.resolve(
            new Response(JSON.stringify(list), { status: 200 }),
          );
        }

        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

    const session = testWhiteboardSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardTraceView />
        </WhiteboardSessionProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('select[aria-label="Trace source"]'),
      ).not.toBeNull();
    });

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Trace source"]',
    );

    expect(select).not.toBeNull();
    expect(select?.value).toBe("s3");
    expect(container.textContent).not.toContain("Showing a saved copy");

    await act(async () => {
      if (!select) throw new Error("missing select");

      // Bypass React tracking so the change event fires.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;

      setter?.call(select, "hosted");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Showing a saved copy; the trace store did not answer.",
      );
    });

    expect(
      requested.some((url) => url.includes("/agent-traces?storage=hosted")),
    ).toBe(true);
    expect(
      requested.some(
        (url) =>
          url.includes("/agent-traces/session-1?") &&
          url.includes("storage=hosted"),
      ),
    ).toBe(true);
  });

  it("shows the storage error instead of the unconfigured hint", async () => {
    const requestMock = vi
      .fn<WhiteboardCanvasBridge["request"]>()
      .mockImplementation((url) => {
        if (url.includes("/agent-traces")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...mockListResponse,
                configured: false,
                sessions: [],
                storageError: "Set current-store in config.json.",
              }),
              { status: 200 },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

    const session = testWhiteboardSession({}, { request: requestMock });
    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardTraceView />
        </WhiteboardSessionProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Set current-store in config.json.",
      );
    });
    expect(container.textContent).not.toContain(
      "Agent traces are not configured.",
    );
  });

  it("shows unconfigured state when list returns configured: false", async () => {
    const unconfiguredList: Extract<
      WhiteboardAgentTraceListResponse,
      { ok: true }
    > = {
      ok: true,
      configured: false,
      sessions: [],
    };

    const requestMock = vi
      .fn<WhiteboardCanvasBridge["request"]>()
      .mockImplementation((url) => {
        if (url.includes("/agent-traces")) {
          return Promise.resolve(
            new Response(JSON.stringify(unconfiguredList), { status: 200 }),
          );
        }

        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

    const session = testWhiteboardSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardTraceView />
        </WhiteboardSessionProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Agent traces are not configured",
      );
    });
  });

  it("renders thinking events collapsed by default under a Thinking tool section", async () => {
    const traceWithThinking: Extract<
      WhiteboardAgentTraceResponse,
      { ok: true }
    > = {
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

    const requestMock = vi
      .fn<WhiteboardCanvasBridge["request"]>()
      .mockImplementation((url) => {
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

    const session = testWhiteboardSession({}, { request: requestMock });

    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardTraceView />
        </WhiteboardSessionProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector("details.whiteboard-trace-worked"),
      ).not.toBeNull();
    });

    // Expand the turn's worked section
    const workedDetails = container.querySelector(
      "details.whiteboard-trace-worked",
    ) as HTMLDetailsElement;

    expect(workedDetails).not.toBeNull();
    act(() => {
      workedDetails.open = true;
    });

    // Find the thinking details element
    const thinkingDetails = Array.from(
      container.querySelectorAll("details.whiteboard-trace-tool--expandable"),
    ).find(
      (el) =>
        el.querySelector(".whiteboard-trace-tool-verb")?.textContent ===
        "Thinking",
    ) as HTMLDetailsElement | undefined;

    expect(thinkingDetails).toBeDefined();
    // Should be collapsed by default
    expect(thinkingDetails?.open).toBe(false);
    expect(
      thinkingDetails?.querySelector(".whiteboard-trace-tool-verb")
        ?.textContent,
    ).toBe("Thinking");
    expect(
      thinkingDetails?.querySelector(".whiteboard-trace-figure-head")
        ?.textContent,
    ).toBe("Thinking");
    expect(
      thinkingDetails?.querySelector(".whiteboard-trace-figure-body--thinking")
        ?.textContent,
    ).toContain("Let me think about how to solve this problem...");
  });
});
