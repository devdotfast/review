import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewOpenWatchdog } from "./review-open-watchdog";

const first = { reviewUuid: "r1", presentationSessionId: "p1" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReviewOpenWatchdog", () => {
  it("fires once per session and tolerates a late presented", () => {
    const timeouts: unknown[] = [];

    const watchdog = new ReviewOpenWatchdog({
      onTimeout: (context, elapsedMs) => timeouts.push([context, elapsedMs]),
    });

    watchdog.started(first);
    vi.advanceTimersByTime(29_999);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timeouts).toEqual([[first, 30_000]]);
    watchdog.presented("p1");
    vi.advanceTimersByTime(60_000);
    expect(timeouts).toHaveLength(1);
  });

  it("keys on the presentation, so a resumed review is timed on its own", () => {
    const timeouts: string[] = [];

    const watchdog = new ReviewOpenWatchdog({
      onTimeout: (context) => timeouts.push(context.presentationSessionId),
    });

    watchdog.started(first);
    vi.advanceTimersByTime(1_000);
    watchdog.presented("p1");
    watchdog.started({ reviewUuid: "r1", presentationSessionId: "p2" });
    watchdog.started({ reviewUuid: "r1", presentationSessionId: "p2" });
    vi.advanceTimersByTime(30_000);
    expect(timeouts).toEqual(["p2"]);

    watchdog.started(first);
    watchdog.dispose();
    vi.advanceTimersByTime(30_000);
    expect(timeouts).toEqual(["p2"]);
  });
});
