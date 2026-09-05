// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import {
  type PanelCodeLine,
  PanelCodeSurface,
  type PanelLineBadge,
  type PanelSelectionSide,
  type PanelThreadController,
  type PanelThreadInjectionTarget,
} from "./sidepeek-thread-ui";

// jsdom does not implement ResizeObserver, and PanelCodeSurface attaches one to
// re-measure rows when the layout changes. These tests assert presence of the
// right-rail badge and the injected thread overlay, not layout, so a stub that
// never fires is sufficient.
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= StubResizeObserver;

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("PanelCodeSurface authored-code rail badges", () => {
  it("renders the right-rail badge for authored code (rows omit data-line-side, badge carries side=additions)", async () => {
    const lines: PanelCodeLine[] = [
      { key: "line:1", line: 1, text: "const one = 1;" },
      { key: "line:2", line: 2, text: "const two = 2;" },
      { key: "line:3", line: 3, text: "return one + two;" },
    ];
    const controller = makeController({
      lineBadges: [{ line: 2, count: 1, side: "additions" }],
      threadRanges: [
        { threadId: "t1", count: 1, fromLine: 2, toLine: 2, side: "additions" },
      ],
    });

    const container = await renderSurface(lines, controller);

    expect(container.querySelectorAll(".panel-code-thread-badge")).toHaveLength(
      1,
    );
  });

  it("respects the badge side on a two-sided diff surface without cross-matching rows", async () => {
    const lines: PanelCodeLine[] = [
      { key: "line:1", line: 1, side: "additions", text: "added" },
      { key: "line:2", line: 2, side: "deletions", text: "removed" },
    ];
    const controller = makeController({
      lineBadges: [
        { line: 1, count: 2, side: "additions" },
        { line: 2, count: 1, side: "deletions" },
      ],
      threadRanges: [
        { threadId: "t1", count: 2, fromLine: 1, toLine: 1, side: "additions" },
        { threadId: "t2", count: 1, fromLine: 2, toLine: 2, side: "deletions" },
      ],
    });

    const container = await renderSurface(lines, controller);

    const badges = container.querySelectorAll<HTMLElement>(
      ".panel-code-thread-badge",
    );
    expect(badges).toHaveLength(2);
    expect(badges[0]!.getAttribute("aria-label")).toBe(
      "Open 2 comments on line 1",
    );
    expect(badges[1]!.getAttribute("aria-label")).toBe(
      "Open 1 comments on line 2",
    );
  });

  it("does not match a deletions badge against additions-only rows (preserves strict side matching when both sides are present)", async () => {
    const lines: PanelCodeLine[] = [
      { key: "line:1", line: 1, side: "additions", text: "const one = 1;" },
      { key: "line:2", line: 2, side: "additions", text: "const two = 2;" },
      { key: "line:3", line: 3, side: "additions", text: "return one + two;" },
    ];
    const controller = makeController({
      lineBadges: [{ line: 2, count: 1, side: "deletions" }],
      threadRanges: [
        { threadId: "t1", count: 1, fromLine: 2, toLine: 2, side: "deletions" },
      ],
    });

    const container = await renderSurface(lines, controller);

    expect(container.querySelectorAll(".panel-code-thread-badge")).toHaveLength(
      0,
    );
  });
});

describe("PanelCodeSurface authored-code thread injection overlay", () => {
  it("renders the overlay for authored code (injection side=additions, rows omit data-line-side)", async () => {
    const lines: PanelCodeLine[] = [
      { key: "line:1", line: 1, text: "const one = 1;" },
      { key: "line:2", line: 2, text: "const two = 2;" },
      { key: "line:3", line: 3, text: "return one + two;" },
    ];
    const controller = makeController({
      threadInjection: {
        kind: "draft",
        key: "draft:d1",
        line: 3,
        side: "additions",
      },
    });

    const container = await renderSurface(lines, controller);

    expect(container.querySelectorAll(".panel-thread-overlay")).toHaveLength(1);
  });

  it("does not match a deletions injection against additions-only rows", async () => {
    const lines: PanelCodeLine[] = [
      { key: "line:1", line: 1, side: "additions", text: "const one = 1;" },
      { key: "line:2", line: 2, side: "additions", text: "const two = 2;" },
      { key: "line:3", line: 3, side: "additions", text: "return one + two;" },
    ];
    const controller = makeController({
      threadInjection: {
        kind: "draft",
        key: "draft:d1",
        line: 3,
        side: "deletions",
      },
    });

    const container = await renderSurface(lines, controller);

    expect(container.querySelectorAll(".panel-thread-overlay")).toHaveLength(0);
  });
});

function makeController(
  overrides: Partial<PanelThreadController>,
): PanelThreadController {
  return {
    anchor: testAnchor("authored"),
    sourceText: undefined,
    sourceFromLine: 1,
    activeThreadId: null,
    activeRange: null,
    draftRange: null,
    dragRange: null,
    selectedRange: null,
    threadInjection: null,
    threadRanges: [],
    lineBadges: [],
    isBadgeActive: () => false,
    activateLine: () => {},
    activateThread: () => {},
    beginLineSelection: () => {},
    changeLineSelection: () => {},
    endLineSelection: () => {},
    renderThreadInjection: () => null,
    renderThreadArea: () => null,
    renderThreadFooter: () => null,
    renderTitleMarker: () => null,
    ...overrides,
  };
}

async function renderSurface(
  lines: readonly PanelCodeLine[],
  controller: PanelThreadController,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<PanelCodeSurface lines={lines} controller={controller} />);
  });
  return container;
}

function testAnchor(id: string): AnchorRef {
  return {
    __kind: "db-anchor-ref",
    id,
    title: "Authored code",
  };
}
