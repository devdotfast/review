import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { readServerSentEvents, stopOpenCodeProcess } from "./opencode-http";

describe("OpenCode SSE framing", () => {
  it("parses CRLF, LF, multiline data, comments, blank events, and split chunks", async () => {
    const source = [
      ": keepalive\r\n",
      "event: ignored\r\n",
      'data: {"type":\r\n',
      'data: "server.connected"}\r\n',
      "\r\n",
      "\n",
      ": another comment\n",
      'data: {"type":"session.idle",\n',
      'data: "properties":{"sessionID":"session-1"}}\n',
      "\n",
    ].join("");
    const chunks = [...source].map((character) =>
      new TextEncoder().encode(character),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const events: string[] = [];

    await readServerSentEvents(stream, new AbortController().signal, (data) =>
      events.push(data),
    );

    expect(events).toEqual([
      '{"type":\n"server.connected"}',
      '{"type":"session.idle",\n"properties":{"sessionID":"session-1"}}',
    ]);
  });

  it("discards an unterminated event at EOF", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"session.idle"'),
        );
        controller.close();
      },
    });
    const events: string[] = [];

    await readServerSentEvents(stream, new AbortController().signal, (data) =>
      events.push(data),
    );

    expect(events).toEqual([]);
  });
});

describe("OpenCode process shutdown", () => {
  it("waits for SIGTERM, forces SIGKILL, and awaits the stubborn child exit", async () => {
    const child = new EventEmitter() as ChildProcess;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      spawnargs: [],
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>((signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          Object.defineProperty(child, "exitCode", {
            value: 0,
            configurable: true,
          });
          queueMicrotask(() => child.emit("close", 0, "SIGKILL"));
        }
        return true;
      }),
    });

    await stopOpenCodeProcess(child, 1);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
  });

  it("does not signal a child that already exited by signal", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null,
      signalCode: "SIGTERM",
      spawnargs: [],
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
    });

    await stopOpenCodeProcess(child, 1);

    expect(child.kill).not.toHaveBeenCalled();
  });
});
