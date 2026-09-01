// @vitest-environment jsdom

import type { ReviewAgentTraceEvent } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildIndexedTraceTurns } from "./trace-document";
import {
  RULER_PAD,
  RULER_TICK_PITCH,
  TraceRuler,
  rulerBucketRange,
  rulerCombWidth,
  rulerNearestTick,
  rulerPreview,
  rulerTickCount,
  rulerTickForEvent,
  rulerTurnForEvent,
  rulerTurnStarts,
} from "./trace-ruler";

function userEvent(text: string): ReviewAgentTraceEvent {
  return { kind: "user", text };
}

function assistantEvent(markdown: string): ReviewAgentTraceEvent {
  return { kind: "assistant", markdown };
}

function toolEvent(title: string): ReviewAgentTraceEvent {
  return { kind: "tool", tool: "shell", verb: "Ran", title };
}

describe("ruler geometry", () => {
  it("caps the tick count at one tick per event and at the rail capacity", () => {
    expect(rulerTickCount(RULER_PAD * 2 + RULER_TICK_PITCH * 40, 597)).toBe(40);
    expect(rulerTickCount(RULER_PAD * 2 + RULER_TICK_PITCH * 40, 6)).toBe(6);
    expect(rulerTickCount(0, 100)).toBe(0);
    expect(rulerTickCount(400, 0)).toBe(0);
  });

  it("covers every event exactly once across bucket ranges", () => {
    const tickCount = 7;
    const eventCount = 23;
    let next = 0;
    for (let tick = 0; tick < tickCount; tick += 1) {
      const { start, end } = rulerBucketRange(tick, tickCount, eventCount);
      expect(start).toBe(next);
      expect(end).toBeGreaterThan(start);
      next = end;
    }
    expect(next).toBe(eventCount);
  });

  it("maps events back to the tick whose bucket contains them", () => {
    const tickCount = 7;
    const eventCount = 23;
    for (let index = 0; index < eventCount; index += 1) {
      const tick = rulerTickForEvent(index, tickCount, eventCount);
      const { start, end } = rulerBucketRange(tick, tickCount, eventCount);
      expect(index).toBeGreaterThanOrEqual(start);
      expect(index).toBeLessThan(end);
    }
  });

  it("elongates the hovered tick most and tapers to rest width", () => {
    expect(rulerCombWidth(10, null)).toBe(6);
    expect(rulerCombWidth(10, 10)).toBe(30);
    const near = rulerCombWidth(11, 10);
    const far = rulerCombWidth(13, 10);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(6);
    expect(rulerCombWidth(20, 10)).toBe(6);
  });
});

describe("rulerNearestTick", () => {
  const rects = [
    { top: 110, bottom: 112 },
    { top: 124, bottom: 126 },
    { top: 138, bottom: 140 },
    { top: 152, bottom: 154 },
  ];

  it("picks the tick whose rendered center is nearest the pointer", () => {
    expect(rulerNearestTick(rects, 111)).toBe(0);
    expect(rulerNearestTick(rects, 130)).toBe(1);
    expect(rulerNearestTick(rects, 133)).toBe(2);
    expect(rulerNearestTick(rects, 900)).toBe(3);
    expect(rulerNearestTick(rects, 0)).toBe(0);
  });

  it("ignores assumed pitch: uneven rendered spacing still resolves exactly", () => {
    const uneven = [
      { top: 10, bottom: 12 },
      { top: 50, bottom: 52 },
      { top: 53, bottom: 55 },
    ];
    expect(rulerNearestTick(uneven, 30)).toBe(0);
    expect(rulerNearestTick(uneven, 52.4)).toBe(1);
    expect(rulerNearestTick(uneven, 53.6)).toBe(2);
  });

  it("returns null with no rendered ticks", () => {
    expect(rulerNearestTick([], 100)).toBe(null);
  });
});

describe("turn ticks", () => {
  const events: ReviewAgentTraceEvent[] = [
    toolEvent("setup"),
    userEvent("can you help root cause this"),
    assistantEvent("I will isolate the break."),
    toolEvent("rg -n reviewUnifiedTargetForRange"),
    toolEvent("sed -n 280,340p"),
    assistantEvent("Root cause confirmed."),
    userEvent("whats the clean fix here"),
    assistantEvent("Keep the synthetic buffer and delegate."),
    userEvent("ok do it"),
  ];
  const turns = buildIndexedTraceTurns(events);

  it("uses the trace view's own turn grouping: one turn per user prompt", () => {
    expect(turns.map((turn) => turn.user?.index ?? null)).toEqual([
      null,
      1,
      6,
      8,
    ]);
    expect(rulerTurnStarts(turns)).toEqual([0, 1, 6, 8]);
  });

  it("maps every event to the turn that contains it", () => {
    const starts = rulerTurnStarts(turns);
    expect([0, 1, 5, 6, 7, 8].map((i) => rulerTurnForEvent(i, starts))).toEqual(
      [0, 1, 1, 2, 2, 3],
    );
  });

  it("previews a turn as its prompt plus the final agent response", () => {
    // Consecutive turns preview consecutive prompts; the snippet is the
    // trailing response after the collapsed work, not the first assistant
    // message inside it.
    expect(rulerPreview(turns[1])).toEqual({
      title: "can you help root cause this",
      snippet: "Root cause confirmed.",
    });
    expect(rulerPreview(turns[2])).toEqual({
      title: "whats the clean fix here",
      snippet: "Keep the synthetic buffer and delegate.",
    });
    expect(rulerPreview(turns[3])).toEqual({ title: "ok do it", snippet: "" });
  });

  it("returns null for a promptless leading turn or a missing turn", () => {
    expect(rulerPreview(turns[0])).toBe(null);
    expect(rulerPreview(undefined)).toBe(null);
  });

  it("collapses whitespace in titles and snippets", () => {
    const [turn] = buildIndexedTraceTurns([
      userEvent("a\n\n  b"),
      assistantEvent("c\td"),
    ]);
    expect(rulerPreview(turn)).toEqual({ title: "a b", snippet: "c d" });
  });
});

describe("TraceRuler", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

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
  });

  it("renders nothing for an empty trace", async () => {
    await act(async () => {
      root?.render(<TraceRuler events={[]} />);
    });
    expect(container.querySelector(".review-trace-ruler")).toBe(null);
  });

  it("renders the ruler anchor for a populated trace", async () => {
    await act(async () => {
      root?.render(<TraceRuler events={[userEvent("hi")]} />);
    });
    expect(container.querySelector(".review-trace-ruler")).not.toBe(null);
  });
});
