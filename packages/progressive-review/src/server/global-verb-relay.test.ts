import { describe, expect, it, vi } from "vitest";

import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay";

describe("global Review Desktop verb relay", () => {
  it("attaches one transport-independent writer and correlates results", async () => {
    const relay = new GlobalReviewDesktopVerbRelay();
    const first = createWriter();
    const second = createWriter();

    expect(relay.attach(first.writer)).toBe(true);
    expect(relay.attach(second.writer)).toBe(false);
    expect(relay.attached).toBe(true);

    const result = relay.dispatch("session-one", {
      name: "state",
      args: {},
    });
    await vi.waitFor(() => expect(first.frames).toHaveLength(1));
    const message = JSON.parse(first.frames[0].slice(6)) as {
      id: string;
      sessionId: string;
    };

    expect(
      relay.acceptResult({
        id: message.id,
        sessionId: "wrong-session",
        response: { ok: true },
      }),
    ).toBe(false);
    expect(
      relay.acceptResult({
        id: message.id,
        sessionId: message.sessionId,
        response: { ok: true, result: { focused: true } },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      ok: true,
      result: { focused: true },
    });

    first.abort.abort();
    expect(relay.attached).toBe(false);
    await expect(
      relay.dispatch("session-one", { name: "state", args: {} }),
    ).resolves.toEqual({
      ok: false,
      error: "No Review Desktop is attached.",
    });
  });

  it("resolves pending verbs on timeout, disconnect, and close", async () => {
    vi.useFakeTimers();
    try {
      const timeoutRelay = new GlobalReviewDesktopVerbRelay(25);
      const timeoutWriter = createWriter();
      timeoutRelay.attach(timeoutWriter.writer);
      const timedOut = timeoutRelay.dispatch("session-one", {
        name: "state",
        args: {},
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(timedOut).resolves.toEqual({
        ok: false,
        error: "Review Desktop verb timed out.",
      });

      const disconnectRelay = new GlobalReviewDesktopVerbRelay();
      const disconnectWriter = createWriter();
      disconnectRelay.attach(disconnectWriter.writer);
      const disconnected = disconnectRelay.dispatch("session-one", {
        name: "state",
        args: {},
      });
      disconnectWriter.abort.abort();
      await expect(disconnected).resolves.toEqual({
        ok: false,
        error: "No Review Desktop is attached.",
      });

      const closedRelay = new GlobalReviewDesktopVerbRelay();
      const closedWriter = createWriter();
      closedRelay.attach(closedWriter.writer);
      const closed = closedRelay.dispatch("session-one", {
        name: "state",
        args: {},
      });
      closedRelay.close();
      expect(closedWriter.close).toHaveBeenCalledOnce();
      await expect(closed).resolves.toEqual({
        ok: false,
        error: "Review Desktop relay closed.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createWriter() {
  const abort = new AbortController();
  const close = vi.fn<() => void>();
  const frames: string[] = [];
  return {
    abort,
    close,
    frames,
    writer: {
      signal: abort.signal,
      write(frame: string) {
        frames.push(frame);
      },
      close,
    },
  };
}
