import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ReviewVerbRequest } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeHttpClient } from "./opencode-http";
import {
  OpenCodeClient,
  OpenCodeWorkspaceRuntime,
  type OpenCodeWorkspaceRuntimeInput,
  openCodeMessageId,
} from "./opencode-runtime";

type NativeTerminalInput = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"];

const REVIEW_MESSAGE_ID = "123e4567-e89b-12d3-a456-426614174000";
const OPEN_CODE_MESSAGE_ID = "msg_123e4567e89b12d3a456426614174000";

afterEach(() => vi.restoreAllMocks());

describe("OpenCodeWorkspaceRuntime", () => {
  it("forks, confirms, prompts, and attaches to the exact managed session", async () => {
    const fixture = runtimeFixture();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    const handle = await fixture.runtime.launchTurn({
      launchId: "launch-1",
      threadId: "thread-1",
      reviewMessageId: REVIEW_MESSAGE_ID,
      cwd: "/workspace/review",
      prompt: "Explain this Review",
      route: {
        kind: "fork",
        source: { harness: "opencode", sessionId: "frozen-source" },
      },
    });

    await expect(handle.accepted).resolves.toEqual({
      harness: "opencode",
      sessionId: "forked-session",
    });
    expect(fixture.openTerminal).toHaveBeenCalledWith({
      launchId: "launch-1",
      harness: "opencode",
      cwd: "/workspace/review",
      executable: "opencode",
      args: [
        "attach",
        "http://127.0.0.1:43123",
        "--dir",
        "/workspace/review",
        "--session",
        "forked-session",
      ],
      env: {
        OPENCODE_SERVER_USERNAME: "review",
        OPENCODE_SERVER_PASSWORD: expect.any(String),
      },
    });
    expect(fixture.openTerminal.mock.calls[0]?.[0].args).not.toContain(
      "--fork",
    );
    expect(fixture.spawnProcess).toHaveBeenCalledOnce();
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/session/frozen-source/fork",
          directory: "/workspace/review",
          body: {},
        }),
        expect.objectContaining({
          path: "/session/forked-session/prompt_async",
          body: {
            messageID: OPEN_CODE_MESSAGE_ID,
            parts: [{ type: "text", text: "Explain this Review" }],
          },
        }),
      ]),
    );
    await fixture.runtime.close();
  });

  it("restarts the workspace server after its owned process exits", async () => {
    const fixture = runtimeFixture();
    const binding = {
      harness: "opencode" as const,
      sessionId: "bound-session",
    };
    await fixture.runtime.openSession({
      launchId: "first",
      cwd: "/workspace/review",
      binding,
    });
    Object.defineProperty(fixture.children[0]!, "exitCode", {
      value: 1,
      configurable: true,
    });

    await fixture.runtime.openSession({
      launchId: "second",
      cwd: "/workspace/review",
      binding,
    });

    expect(fixture.spawnProcess).toHaveBeenCalledTimes(2);
    await fixture.runtime.close();
  });

  it("restarts after the workspace server exits by signal", async () => {
    const fixture = runtimeFixture();
    const binding = {
      harness: "opencode" as const,
      sessionId: "bound-session",
    };
    await fixture.runtime.openSession({
      launchId: "first",
      cwd: "/workspace/review",
      binding,
    });
    Object.defineProperty(fixture.children[0]!, "signalCode", {
      value: "SIGTERM",
      configurable: true,
    });

    await fixture.runtime.openSession({
      launchId: "second",
      cwd: "/workspace/review",
      binding,
    });

    expect(fixture.spawnProcess).toHaveBeenCalledTimes(2);
    await fixture.runtime.close();
  });

  it("bounds a failed restart after the workspace server exits by signal", async () => {
    const fixture = runtimeFixture({
      startupError: new Error("spawn opencode ENOENT"),
      startupErrorAfter: 1,
    });
    const binding = {
      harness: "opencode" as const,
      sessionId: "bound-session",
    };
    await fixture.runtime.openSession({
      launchId: "first",
      cwd: "/workspace/review",
      binding,
    });
    Object.defineProperty(fixture.children[0]!, "signalCode", {
      value: "SIGTERM",
      configurable: true,
    });

    await expect(
      fixture.runtime.openSession({
        launchId: "restart",
        cwd: "/workspace/review",
        binding,
      }),
    ).rejects.toThrow(/server did not become ready.*reported version unknown/s);
    expect(fixture.spawnProcess).toHaveBeenCalledTimes(3);
    await fixture.runtime.close();
  });

  it("does not call a signal-terminated server during close", async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.openSession({
      launchId: "first",
      cwd: "/workspace/review",
      binding: { harness: "opencode", sessionId: "bound-session" },
    });
    Object.defineProperty(fixture.children[0]!, "signalCode", {
      value: "SIGTERM",
      configurable: true,
    });
    fixture.requests.length = 0;

    await fixture.runtime.close();

    expect(fixture.requests).toEqual([]);
    expect(fixture.childSignals[0]).toEqual([]);
  });

  it("resumes a bound session and reopens it without another prompt", async () => {
    const fixture = runtimeFixture();
    const binding = {
      harness: "opencode" as const,
      sessionId: "bound-session",
    };

    await fixture.runtime.launchTurn({
      launchId: "resume",
      threadId: "thread-1",
      reviewMessageId: REVIEW_MESSAGE_ID,
      cwd: "/workspace/review",
      prompt: "A later question",
      route: { kind: "resume", session: binding },
    });
    await fixture.runtime.openSession({
      launchId: "reopen",
      cwd: "/workspace/review",
      binding,
    });

    expect(fixture.openTerminal).toHaveBeenCalledTimes(2);
    expect(fixture.openTerminal.mock.calls[1]?.[0].args).toContain(
      "bound-session",
    );
    expect(
      fixture.requests.filter((request) =>
        request.path.endsWith("/prompt_async"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.requests.some((request) => request.path.endsWith("/fork")),
    ).toBe(false);
    await fixture.runtime.close();
  });

  it("treats retry as running and aborts only tracked sessions on shutdown", async () => {
    const fixture = runtimeFixture({
      statuses: {
        "bound-session": {
          type: "retry",
          attempt: 2,
          message: "again",
          next: 1,
        },
        foreign: { type: "busy" },
      },
    });
    fixture.runtime.observe({
      harness: "opencode",
      sessionId: "bound-session",
    });
    await fixture.runtime.openSession({
      launchId: "reopen",
      cwd: "/workspace/review",
      binding: { harness: "opencode", sessionId: "bound-session" },
    });

    await fixture.runtime.close();

    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/session/bound-session/abort" }),
      ]),
    );
    expect(
      fixture.requests.some(
        (request) => request.path === "/session/foreign/abort",
      ),
    ).toBe(false);
  });

  it("aborts its new session when the terminal cannot open", async () => {
    const fixture = runtimeFixture({
      statuses: { "forked-session": { type: "busy" } },
      terminalError: new Error("terminal unavailable"),
    });

    await expect(
      fixture.runtime.launchTurn({
        launchId: "failed-terminal",
        threadId: "thread-1",
        reviewMessageId: REVIEW_MESSAGE_ID,
        cwd: "/workspace/review",
        prompt: "question",
        route: {
          kind: "fork",
          source: { harness: "opencode", sessionId: "frozen-source" },
        },
      }),
    ).rejects.toThrow("terminal unavailable");

    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/session/forked-session/abort" }),
      ]),
    );
    expect(
      fixture.requests.some((request) =>
        request.path.endsWith("/prompt_async"),
      ),
    ).toBe(false);
    await fixture.runtime.close();
  });

  it("accepts an ambiguously failed prompt only after its stable message appears", async () => {
    const fixture = runtimeFixture({
      promptResult: "accepted-transport-failure",
    });

    await expect(
      fixture.runtime.launchTurn({
        launchId: "ambiguous-prompt",
        threadId: "thread-1",
        reviewMessageId: REVIEW_MESSAGE_ID,
        cwd: "/workspace/review",
        prompt: "question",
        route: {
          kind: "resume",
          session: { harness: "opencode", sessionId: "bound-session" },
        },
      }),
    ).resolves.toBeDefined();

    expect(
      fixture.requests.filter((request) =>
        request.path.endsWith("/prompt_async"),
      ),
    ).toHaveLength(1);
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `/session/bound-session/message/${OPEN_CODE_MESSAGE_ID}`,
        }),
      ]),
    );
    await fixture.runtime.close();
  });

  it("rejects a definitive prompt failure without retry or reconciliation", async () => {
    const fixture = runtimeFixture({ promptResult: "rejected" });

    await expect(
      fixture.runtime.launchTurn({
        launchId: "rejected-prompt",
        threadId: "thread-1",
        reviewMessageId: REVIEW_MESSAGE_ID,
        cwd: "/workspace/review",
        prompt: "question",
        route: {
          kind: "resume",
          session: { harness: "opencode", sessionId: "bound-session" },
        },
      }),
    ).rejects.toThrow("prompt_async failed (400)");

    expect(
      fixture.requests.filter((request) =>
        request.path.endsWith("/prompt_async"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.requests.some((request) =>
        request.path.includes(`/message/${OPEN_CODE_MESSAGE_ID}`),
      ),
    ).toBe(false);
    await fixture.runtime.close();
  });

  it("derives a stable OpenCode-safe message ID from the Review UUID", () => {
    expect(openCodeMessageId(REVIEW_MESSAGE_ID)).toBe(OPEN_CODE_MESSAGE_ID);
    expect(openCodeMessageId(REVIEW_MESSAGE_ID.toUpperCase())).toBe(
      OPEN_CODE_MESSAGE_ID,
    );
    expect(() => openCodeMessageId("review-message-1")).toThrow("Review UUID");
  });

  it("prepares a completed tutorial source without opening a terminal", async () => {
    const fixture = runtimeFixture({
      messageSnapshots: [
        [],
        [
          message(
            "tutorial-user",
            "user",
            "tutorial context",
            true,
            "new-session",
          ),
          message("tutorial-answer", "assistant", "ready", true, "new-session"),
        ],
      ],
    });

    await expect(
      fixture.runtime.createTutorialSource("tutorial context"),
    ).resolves.toEqual({ harness: "opencode", sessionId: "new-session" });
    expect(fixture.openTerminal).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/session/new-session/prompt_async",
          body: expect.objectContaining({
            parts: [{ type: "text", text: "tutorial context" }],
            tools: { "*": false },
          }),
        }),
      ]),
    );
    await fixture.runtime.close();
  });

  it("forces and awaits shutdown of a stubborn managed server", async () => {
    const fixture = runtimeFixture({ stubbornChild: true });
    await fixture.runtime.openSession({
      launchId: "stubborn",
      cwd: "/workspace/review",
      binding: { harness: "opencode", sessionId: "bound-session" },
    });

    await fixture.runtime.close();

    expect(fixture.childSignals[0]).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fixture.children[0]?.exitCode).toBe(0);
  });
});

describe("OpenCode observation fixtures", () => {
  it("rejects an initial runtime startup failure after bounded attempts", async () => {
    const fixture = runtimeFixture({
      startupError: new Error("spawn opencode ENOENT"),
    });

    await expect(
      fixture.runtime
        .observe({ harness: "opencode", sessionId: "bound-session" })
        .updates(),
    ).rejects.toThrow(/server did not become ready.*reported version unknown/s);
    expect(fixture.spawnProcess).toHaveBeenCalledTimes(2);
    await fixture.runtime.close();
  });

  it("surfaces a version-aware error after bounded reconnect failures", async () => {
    const fixture = runtimeFixture({
      closeFirstEventStream: true,
      eventFailureAfter: 1,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).rejects.toThrow(
      "event network unavailable (reported version 1.18.23)",
    );
    expect(
      fixture.requests.filter((request) => request.path === "/event"),
    ).toHaveLength(2);
    await pipe.close();
    await fixture.runtime.close();
  });

  it("bounds event streams that handshake and then become malformed", async () => {
    const fixture = runtimeFixture({
      rawEventStreams: [
        {
          text: 'data: {"type":"server.connected"}\n\ndata: not-json\n\n',
          close: true,
        },
      ],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).rejects.toThrow(
      "event stream returned invalid JSON (reported version 1.18.23)",
    );
    expect(
      fixture.requests.filter((request) => request.path === "/event"),
    ).toHaveLength(2);
    await pipe.close();
    await fixture.runtime.close();
  });

  it("bounds event streams that close after only the handshake", async () => {
    const fixture = runtimeFixture({
      rawEventStreams: [
        {
          text: 'data: {"type":"server.connected"}\n\n',
          close: true,
        },
      ],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).rejects.toThrow(
      "event stream closed unexpectedly (reported version 1.18.23)",
    );
    expect(
      fixture.requests.filter((request) => request.path === "/event"),
    ).toHaveLength(2);
    await pipe.close();
    await fixture.runtime.close();
  });

  it.each([
    ["idle", "session.idle"],
    ["error", "session.error"],
    ["abort", "session.status"],
  ])(
    "subscribes before snapshots and recovers final state when %s occurs during startup",
    async (_case, eventType) => {
      const fixture = runtimeFixture({
        messageSnapshots: [
          [message("user-1", "user", "question")],
          [
            message("user-1", "user", "question"),
            message("assistant-1", "assistant", "final", true),
          ],
        ],
        statusSnapshots: [{ "bound-session": { type: "busy" } }, {}],
        eventBlocks: [event(eventType, "bound-session")],
      });

      const pipe = await fixture.runtime
        .observe({ harness: "opencode", sessionId: "bound-session" })
        .updates();

      expect(
        fixture.requests.findIndex((request) => request.path === "/event"),
      ).toBeLessThan(
        fixture.requests.findIndex(
          (request) => request.path === "/session/status",
        ),
      );
      await expect(nextUpdate(pipe.updates)).resolves.toMatchObject({
        type: "message.updated",
        message: { body: "final" },
      });
      await pipe.close();
      await fixture.runtime.close();
    },
  );

  it("suppresses partial output and deduplicates retry-to-success snapshots", async () => {
    const snapshots = [
      [
        message("user-1", "user", "Ask Review now"),
        message("assistant-1", "assistant", "partial", false),
      ],
      [
        message("assistant-1", "assistant", "complete", true),
        message("user-1", "user", "Ask Review now"),
      ],
    ];
    const fixture = runtimeFixture({
      messageSnapshots: snapshots,
      statuses: {
        "bound-session": {
          type: "retry",
          attempt: 1,
          message: "wait",
          next: 1,
        },
      },
      eventBlocks: [
        event("message.part.updated", "bound-session"),
        event("session.status", "bound-session"),
        event("message.updated", "bound-session"),
      ],
    });
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    expect(pipe.snapshot.messages.map((entry) => entry.body)).toEqual([
      "Ask Review now",
    ]);
    const update = await nextUpdate(pipe.updates);
    expect(update).toMatchObject({
      type: "message.updated",
      message: { role: "assistant", body: "complete" },
    });
    await expectNoUpdate(pipe.updates);
    await pipe.close();
    await fixture.runtime.close();
  });

  it("recovers a completed message after a lost notification and reconnect", async () => {
    const fixture = runtimeFixture({
      messageSnapshots: [
        [message("user-1", "user", "question")],
        [
          message("user-1", "user", "question"),
          message("assistant-1", "assistant", "recovered", true),
        ],
      ],
      eventBlocks: [],
      closeFirstEventStream: true,
    });
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).resolves.toMatchObject({
      type: "message.updated",
      message: { body: "recovered" },
    });
    await pipe.close();
    await fixture.runtime.close();
  });

  it("discards a mid-frame disconnect and reconciles after reconnect", async () => {
    const fixture = runtimeFixture({
      messageSnapshots: [
        [message("user-1", "user", "question")],
        [
          message("user-1", "user", "question"),
          message("assistant-1", "assistant", "reconnected", true),
        ],
      ],
      rawEventStreams: [
        { text: 'data: {"type":"session.', close: true },
        {
          text: `data: ${event("server.connected", "bound-session")}\n\n`,
          close: false,
        },
      ],
      finalMessagesAfterReconnect: true,
    });
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).resolves.toMatchObject({
      type: "message.updated",
      message: { body: "reconnected" },
    });
    await vi.waitFor(() =>
      expect(
        fixture.requests.filter((request) => request.path === "/event"),
      ).toHaveLength(2),
    );
    await pipe.close();
    await fixture.runtime.close();
  });

  it("reconciles retry-to-error from the authoritative message snapshot", async () => {
    const fixture = runtimeFixture({
      messageSnapshots: [
        [message("user-1", "user", "question")],
        [
          message("user-1", "user", "question"),
          failedMessage("assistant-1", "provider unavailable"),
        ],
      ],
      statuses: {
        "bound-session": {
          type: "retry",
          attempt: 1,
          message: "wait",
          next: 1,
        },
      },
      eventBlocks: [event("session.error", "bound-session")],
    });
    const pipe = await fixture.runtime
      .observe({ harness: "opencode", sessionId: "bound-session" })
      .updates();

    await expect(nextUpdate(pipe.updates)).resolves.toMatchObject({
      type: "session.failed",
      failure: { error: "provider unavailable" },
    });
    await pipe.close();
    await fixture.runtime.close();
  });

  it("includes the health version in invalid-contract diagnostics", async () => {
    const client = new OpenCodeClient(
      new OpenCodeHttpClient({
        baseUrl: "http://127.0.0.1:1",
        username: "review",
        password: "secret",
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({ unexpected: true }),
        ),
      }),
    );
    client.version = "1.18.23";

    await expect(client.status("/workspace/review")).rejects.toThrow(
      "reported version 1.18.23",
    );
  });
});

interface RequestRecord {
  path: string;
  directory?: string;
  method: string;
  body?: unknown;
}

function runtimeFixture(
  options: {
    messageSnapshots?: unknown[][];
    statuses?: Record<string, unknown>;
    statusSnapshots?: Array<Record<string, unknown>>;
    eventBlocks?: string[];
    rawEventStreams?: Array<{ text: string; close: boolean }>;
    finalMessagesAfterReconnect?: boolean;
    closeFirstEventStream?: boolean;
    terminalError?: Error;
    promptResult?: "accepted-transport-failure" | "rejected";
    stubbornChild?: boolean;
    startupError?: Error;
    startupErrorAfter?: number;
    eventFailureAfter?: number;
  } = {},
): {
  runtime: OpenCodeWorkspaceRuntime;
  openTerminal: ReturnType<typeof vi.fn<(input: NativeTerminalInput) => void>>;
  requests: RequestRecord[];
  spawnProcess: ReturnType<typeof vi.fn<() => ChildProcess>>;
  children: ChildProcess[];
  childSignals: Array<Array<NodeJS.Signals | number | undefined>>;
} {
  const requests: RequestRecord[] = [];
  const openTerminal = vi.fn<(input: NativeTerminalInput) => void>();
  const children: ChildProcess[] = [];
  const childSignals: Array<Array<NodeJS.Signals | number | undefined>> = [];
  const spawnProcess = vi.fn<() => ChildProcess>(() => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = fakeChild(options.stubbornChild === true, signals);
    if (
      options.startupError &&
      (options.startupErrorAfter === undefined ||
        children.length + 1 > options.startupErrorAfter)
    ) {
      queueMicrotask(() => child.emit("error", options.startupError));
    }
    children.push(child);
    childSignals.push(signals);
    return child;
  });
  let messageRead = 0;
  let eventRead = 0;
  let statusRead = 0;
  const messageSnapshots = options.messageSnapshots ?? [[]];
  const fetchMock = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      path: url.pathname,
      directory: url.searchParams.get("directory") ?? undefined,
      method: init.method ?? "GET",
      ...(body !== undefined ? { body } : {}),
    });
    if (url.pathname === "/global/health") {
      if (
        options.startupError &&
        (options.startupErrorAfter === undefined ||
          children.length > options.startupErrorAfter)
      ) {
        throw options.startupError;
      }
      return Response.json({ healthy: true, version: "1.18.23" });
    }
    if (url.pathname === "/session/frozen-source/fork") {
      return Response.json({ id: "forked-session" });
    }
    if (url.pathname === "/session") {
      return Response.json({ id: "new-session" });
    }
    if (url.pathname === "/session/status") {
      const statuses = options.statusSnapshots
        ? options.statusSnapshots[
            Math.min(statusRead, options.statusSnapshots.length - 1)
          ]
        : (options.statuses ?? {});
      statusRead += 1;
      return Response.json(statuses);
    }
    if (url.pathname.endsWith("/message")) {
      if (options.finalMessagesAfterReconnect) {
        return Response.json(messageSnapshots[eventRead >= 2 ? 1 : 0] ?? []);
      }
      const value =
        messageSnapshots[Math.min(messageRead, messageSnapshots.length - 1)]!;
      messageRead += 1;
      return Response.json(value);
    }
    if (url.pathname === "/event") {
      if (
        options.eventFailureAfter !== undefined &&
        eventRead >= options.eventFailureAfter
      ) {
        throw new TypeError("event network unavailable");
      }
      const raw =
        options.rawEventStreams?.[
          Math.min(eventRead, options.rawEventStreams.length - 1)
        ];
      if (raw) {
        eventRead += 1;
        return new Response(rawEventStream(raw.text, init.signal, raw.close), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      const blocks = eventRead === 0 ? (options.eventBlocks ?? []) : [];
      const close = options.closeFirstEventStream === true && eventRead === 0;
      eventRead += 1;
      return new Response(eventStream(blocks, init.signal, close), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname.endsWith("/prompt_async")) {
      if (options.promptResult === "accepted-transport-failure") {
        throw new TypeError("connection closed after write");
      }
      if (options.promptResult === "rejected") {
        return Response.json({ error: "rejected" }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith(`/message/${OPEN_CODE_MESSAGE_ID}`)) {
      return Response.json({
        info: {
          id: OPEN_CODE_MESSAGE_ID,
          sessionID: "bound-session",
          role: "user",
        },
        parts: [],
      });
    }
    if (url.pathname.endsWith("/abort")) {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/instance/dispose") {
      return new Response(null, { status: 204 });
    }
    const id = url.pathname.split("/").at(-1);
    return Response.json({ id });
  });
  const runtime = new OpenCodeWorkspaceRuntime({
    directory: "/workspace/review",
    openTerminal: async (input) => {
      openTerminal(input);
      if (options.terminalError) throw options.terminalError;
    },
    spawn: spawnProcess as OpenCodeWorkspaceRuntimeInput["spawn"],
    fetch: fetchMock,
    reservePort: async () => 43123,
    shutdownTimeoutMs: 1,
  });
  return {
    runtime,
    openTerminal,
    requests,
    spawnProcess,
    children,
    childSignals,
  };
}

function fakeChild(
  stubborn = false,
  signals: Array<NodeJS.Signals | number | undefined> = [],
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 999_999,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    spawnargs: [],
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>((signal) => {
      signals.push(signal);
      if (stubborn && signal !== "SIGKILL") return true;
      Object.defineProperty(child, "exitCode", {
        value: 0,
        configurable: true,
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    }),
  });
  return child;
}

function event(type: string, sessionID: string): string {
  return JSON.stringify({ type, properties: { sessionID } });
}

function eventStream(
  blocks: string[],
  signal: AbortSignal | null | undefined,
  close: boolean,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(new TextEncoder().encode(`data: ${block}\n\n`));
      }
      if (close) controller.close();
      else
        signal?.addEventListener("abort", () => controller.close(), {
          once: true,
        });
    },
  });
}

function rawEventStream(
  text: string,
  signal: AbortSignal | null | undefined,
  close: boolean,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (close) controller.close();
      else
        signal?.addEventListener("abort", () => controller.close(), {
          once: true,
        });
    },
  });
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  completed = role === "user",
  sessionId = "bound-session",
): unknown {
  const messageId = id.startsWith("msg_") ? id : `msg_${id}`;
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role,
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
    },
    parts: [
      {
        id: `${messageId}-text`,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      },
    ],
  };
}

function failedMessage(id: string, error: string): unknown {
  const messageId = id.startsWith("msg_") ? id : `msg_${id}`;
  return {
    info: {
      id: messageId,
      sessionID: "bound-session",
      role: "assistant",
      time: { created: 2 },
      error: { name: "APIError", data: { message: error } },
    },
    parts: [],
  };
}

async function nextUpdate(updates: AsyncIterable<unknown>): Promise<unknown> {
  const iterator = updates[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for update.")),
        2_000,
      ),
    ),
  ]);
  return result.value;
}

async function expectNoUpdate(updates: AsyncIterable<unknown>): Promise<void> {
  const iterator = updates[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next().then(() => "update"),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 50),
    ),
  ]);
  expect(result).toBe("timeout");
}
