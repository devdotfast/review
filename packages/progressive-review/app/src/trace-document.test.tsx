// @vitest-environment jsdom

import type { ReviewAgentTraceEvent } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceDocument } from "./trace-document";

let root: Root | null = null;
let container: HTMLDivElement;

describe("TraceDocument", () => {
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

  const sampleEvents: ReviewAgentTraceEvent[] = [
    // Turn 0: events 0..4
    { kind: "user", text: "First turn question", at: "2025-01-01T00:00:00Z" },
    {
      kind: "tool",
      tool: "edit",
      verb: "Edited",
      title: "src/a.ts",
      input: "edit a",
      at: "2025-01-01T00:00:05Z",
    },
    {
      kind: "tool",
      tool: "edit",
      verb: "Edited",
      title: "src/b.ts",
      input: "edit b",
      at: "2025-01-01T00:00:10Z",
    },
    {
      kind: "tool",
      tool: "edit",
      verb: "Edited",
      title: "src/c.ts",
      input: "edit c",
      at: "2025-01-01T00:00:15Z",
    },
    {
      kind: "assistant",
      thinking: false,
      markdown: "First turn answer.",
      at: "2025-01-01T00:00:20Z",
    },

    // Turn 1: events 5..9 (Target turn)
    { kind: "user", text: "Second turn question", at: "2025-01-01T00:01:00Z" },
    {
      kind: "tool",
      tool: "bash",
      verb: "Ran",
      title: "pnpm build",
      command: "pnpm build",
      at: "2025-01-01T00:01:05Z",
    },
    {
      kind: "tool",
      tool: "bash",
      verb: "Ran",
      title: "pnpm test",
      command: "pnpm test",
      at: "2025-01-01T00:01:10Z",
    },
    {
      kind: "tool",
      tool: "bash",
      verb: "Ran",
      title: "pnpm lint",
      command: "pnpm lint",
      at: "2025-01-01T00:01:15Z",
    },
    {
      kind: "assistant",
      thinking: false,
      markdown: "Second turn answer with optimize database queries in it.",
      at: "2025-01-01T00:01:20Z",
    },
  ];

  it("coalesces tool runs in every turn; a group containing the target renders open", async () => {
    // Target event is event 6 (inside Turn 1)
    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={6}
          highlightQuote="pnpm build"
        />,
      );
    });

    const turns = container.querySelectorAll(".review-trace-turn");
    expect(turns.length).toBe(2);

    // Turn 0 (non-target turn): 3 edit tools should coalesce into 1 TraceToolGroup
    const turn0 = turns[0];
    const turn0ToolGroups = turn0.querySelectorAll(".review-trace-toolgroup");
    expect(turn0ToolGroups.length).toBe(1);
    expect(turn0ToolGroups[0].textContent).toContain("Edited 3 files");

    // Turn 1 (contains targetEventIndex 6): tools coalesce too, but the
    // group holding the target renders expanded so the target stays visible.
    const turn1 = turns[1];
    const turn1ToolGroups = turn1.querySelectorAll(".review-trace-toolgroup");
    expect(turn1ToolGroups.length).toBe(1);
    expect(turn1ToolGroups[0].hasAttribute("open")).toBe(true);
    expect(turn1.textContent).toContain("pnpm build");
    expect(turn1.textContent).toContain("pnpm test");
    expect(turn1.textContent).toContain("pnpm lint");

    // Target event should have #review-trace-target-event
    const targetEl = container.querySelector("#review-trace-target-event");
    expect(targetEl).not.toBeNull();
    expect(targetEl?.textContent).toContain("pnpm build");
  });

  it("renders gap chips when picks are provided and expands them on click", async () => {
    // Picks only include Turn 1 (events 5..9)
    const picks = [
      { event: 5, keep: ["Second turn"] },
      { events: [6, 9] as [number, number] },
    ];

    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={5}
          picks={picks}
        />,
      );
    });

    // Turn 0 is hidden -> gap chip for 5 hidden events
    const initialGaps = container.querySelectorAll(".review-trace-lens-gap");
    expect(initialGaps.length).toBe(1);
    expect(initialGaps[0].textContent).toContain("5 hidden events");

    // Click to expand gap
    const gapButton = initialGaps[0] as HTMLButtonElement;
    await act(async () => {
      gapButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Now Turn 0 is revealed!
    expect(container.textContent).toContain("First turn question");
    expect(container.textContent).toContain("First turn answer.");

    // Tools coalesce in every turn: Turn 0's revealed run plus the target
    // turn's run (which renders open because it contains the target).
    const toolGroups = container.querySelectorAll(".review-trace-toolgroup");
    expect(toolGroups.length).toBe(2);
    expect(toolGroups[0].textContent).toContain("Edited 3 files");
  });

  it("brackets an expanded gap with collapse rows that fold it back", async () => {
    const picks = [
      { event: 5, keep: ["Second turn"] },
      { events: [6, 9] as [number, number] },
    ];

    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={5}
          picks={picks}
        />,
      );
    });

    const gapButton = container.querySelector(
      ".review-trace-lens-gap",
    ) as HTMLButtonElement;
    await act(async () => {
      gapButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The revealed span is bracketed by one collapse row at each end.
    const collapseRows = container.querySelectorAll(
      ".review-trace-lens-collapse",
    );
    expect(collapseRows.length).toBe(2);
    expect(collapseRows[0].textContent).toContain("collapse 5 events");
    expect(collapseRows[1].textContent).toContain("collapse 5 events");

    // The bottom row re-collapses the whole span back to a gap chip.
    await act(async () => {
      (collapseRows[1] as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(
      container.querySelectorAll(".review-trace-lens-collapse").length,
    ).toBe(0);
    expect(container.textContent).not.toContain("First turn question");
    const gapsAfter = container.querySelectorAll(".review-trace-lens-gap");
    expect(gapsAfter.length).toBe(1);
    expect(gapsAfter[0].textContent).toContain("5 hidden events");
  });

  it("expands elided message text when ellipsis chip is clicked", async () => {
    const picks = [{ event: 9, keep: ["optimize database queries"] }];

    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={9}
          highlightQuote="optimize database queries"
          picks={picks}
        />,
      );
    });

    // Message is elided with a ⋯ chip
    const chipButton = container.querySelector(
      ".review-trace-lens-chip",
    ) as HTMLButtonElement;
    expect(chipButton).not.toBeNull();
    expect(
      container.querySelector(".review-trace-quote-mark")?.textContent,
    ).toBe("optimize database queries");

    // Click ⋯ chip
    await act(async () => {
      chipButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Message is now fully expanded
    expect(container.textContent).toContain(
      "Second turn answer with optimize database queries in it.",
    );
  });

  it("renders the entire user message and highlights the quote without elision", async () => {
    // When turn range is included without a keep filter
    const picks = [{ events: [5, 9] as [number, number] }];

    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={5}
          highlightQuote="Second turn"
          picks={picks}
        />,
      );
    });

    // Full text of the user message is visible without ellipsis chips
    expect(container.querySelector(".review-trace-lens-chip")).toBeNull();
    const userBubble = container.querySelector(".agent-chat-user-bubble");
    expect(userBubble?.textContent).toBe("Second turn question");
    expect(
      userBubble?.querySelector(".review-trace-quote-mark")?.textContent,
    ).toBe("Second turn");
  });

  it("scrolls directly to the highlighted quote mark when available", async () => {
    const scrollCalls: Element[] = [];
    Element.prototype.scrollIntoView = vi
      .fn<typeof Element.prototype.scrollIntoView>()
      .mockImplementation(function (this: Element) {
        scrollCalls.push(this);
      });

    await act(async () => {
      root?.render(
        <TraceDocument
          events={sampleEvents}
          targetEventIndex={9}
          highlightQuote="optimize database queries"
          picks={[{ events: [5, 9] }]}
        />,
      );
    });

    const quoteMark = container.querySelector(".review-trace-quote-mark");
    expect(quoteMark).not.toBeNull();
    expect(scrollCalls).toContain(quoteMark);
  });
});
