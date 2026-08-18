// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import {
  buildAuthoredCodeLineTarget,
  codeTargetLineRange,
  groupLineCommentBadges,
  lineFromPointerY,
  panelDraftDismissalAction,
  panelEscapeAction,
  panelLineRangeLabel,
  panelThreadCardNeedsScroll,
  panelThreadHostForTarget,
  panelThreadInjectionTarget,
  panelThreadSectionSessionKey,
  readPanelThreadSectionCollapsed,
  writePanelThreadSectionCollapsed,
} from "./sidepeek-thread-ui";
import { buildCodeTarget } from "./target-fingerprint";

describe("side-peek line interactions", () => {
  it("maps pointer y coordinates to measured line rows and clamps to the nearest row", () => {
    const rows = [
      { line: 41, top: 10, height: 18 },
      { line: 42, top: 28, height: 24 },
      { line: 43, top: 52, height: 18 },
    ];

    expect(lineFromPointerY(rows, 12)).toBe(41);
    expect(lineFromPointerY(rows, 40)).toBe(42);
    expect(lineFromPointerY(rows, 66)).toBe(43);
    expect(lineFromPointerY(rows, -100)).toBe(41);
    expect(lineFromPointerY(rows, 500)).toBe(43);
    expect(lineFromPointerY([], 20)).toBeNull();
  });

  it("groups the right-rail badge count by line", () => {
    expect(
      groupLineCommentBadges([
        { rootIndex: 0, path: [], file: "a.ts", line: 9, count: 2 },
        { rootIndex: 0, path: [], file: "a.ts", line: 7, count: 1 },
        { rootIndex: 0, path: [], file: "a.ts", line: 9, count: 3 },
      ]),
    ).toEqual([
      { line: 7, count: 1 },
      { line: 9, count: 5 },
    ]);
  });

  it("creates canonical code targets and restores their line range", () => {
    const anchor = testAnchor("authored");
    const sourceText = "const one = 1;\nconst two = 2;\nreturn one + two;";
    const created = buildAuthoredCodeLineTarget(
      {
        path: "src/authored.ts",
        side: "head",
        baseCommit: "base-commit",
        headCommit: "head-commit",
      },
      { fromLine: 2, toLine: 3 },
    );

    expect(created.title).toBe("L2–3");
    if (created.target.kind !== "code")
      throw new Error("Expected code target.");
    expect(created.target.position).toMatchObject({
      base_sha: "base-commit",
      start_sha: "base-commit",
      head_sha: "head-commit",
      new_path: "src/authored.ts",
      line_range: {
        start: { type: "new", old_line: null, new_line: 2 },
        end: { type: "new", old_line: null, new_line: 3 },
      },
    });
    expect(
      codeTargetLineRange(created.target, anchor.id, sourceText, 1),
    ).toEqual({ fromLine: 2, toLine: 3, side: "additions" });
    expect(panelLineRangeLabel({ fromLine: 8, toLine: 8 })).toBe("L8");
  });

  it("injects a draft immediately after the selection end line", () => {
    expect(
      panelThreadInjectionTarget({
        draft: {
          threadId: "draft-1",
          range: { fromLine: 922, toLine: 925 },
        },
        expandedThread: null,
      }),
    ).toEqual({ kind: "draft", key: "draft:draft-1", line: 925 });
  });

  it("injects only an expanded thread and leaves minimized badges row-free", () => {
    expect(
      panelThreadInjectionTarget({
        draft: null,
        expandedThread: {
          threadId: "thread-1",
          range: { fromLine: 922, toLine: 925 },
        },
      }),
    ).toEqual({ kind: "thread", key: "thread:thread-1", line: 925 });
    expect(
      panelThreadInjectionTarget({ draft: null, expandedThread: null }),
    ).toBeNull();
  });

  it("assigns title targets to the title host and code targets to content", () => {
    const titleTarget = {
      kind: "text",
      surface: {
        type: "anchor",
        anchorId: "runtime",
        part: { type: "text", field: "title" },
      },
      selection: { start: 0, length: 7, hash: "12345678", quote: "Runtime" },
    } as const;
    const codeTarget = buildCodeTarget({
      path: "src/runtime.ts",
      side: "head",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 10, endLine: 10 },
    });

    expect(panelThreadHostForTarget(titleTarget, "runtime")).toBe("title");
    expect(panelThreadHostForTarget(codeTarget, "runtime")).toBe("content");
    expect(panelThreadHostForTarget(titleTarget, "other")).toBeNull();
  });
});

describe("side-peek draft lifecycle", () => {
  it("keeps typed drafts on outside pointer-down and blurs them on Escape", () => {
    expect(panelDraftDismissalAction("outside-pointer", true)).toBe("keep");
    expect(panelDraftDismissalAction("escape", true)).toBe("blur");
  });

  it("closes empty drafts on outside pointer-down or Escape", () => {
    expect(panelDraftDismissalAction("outside-pointer", false)).toBe("close");
    expect(panelDraftDismissalAction("escape", false)).toBe("close");
  });

  it("scrolls only when the draft card is clipped by the panel viewport", () => {
    const viewport = { top: 100, right: 500, bottom: 700, left: 200 };

    expect(
      panelThreadCardNeedsScroll(
        { top: 120, right: 480, bottom: 680, left: 220 },
        viewport,
      ),
    ).toBe(false);
    expect(
      panelThreadCardNeedsScroll(
        { top: 120, right: 480, bottom: 720, left: 220 },
        viewport,
      ),
    ).toBe(true);
  });

  it("orders Escape as menu, draft, expanded thread, then panel", () => {
    expect(
      panelEscapeAction({
        menuOpen: true,
        draftHasText: true,
        threadExpanded: true,
      }),
    ).toBe("close-menu");
    expect(
      panelEscapeAction({
        menuOpen: false,
        draftHasText: true,
        threadExpanded: true,
      }),
    ).toBe("blur-draft");
    expect(
      panelEscapeAction({
        menuOpen: false,
        draftHasText: null,
        threadExpanded: true,
      }),
    ).toBe("minimize-thread");
    expect(
      panelEscapeAction({
        menuOpen: false,
        draftHasText: null,
        threadExpanded: false,
      }),
    ).toBe("close-panel");
  });
});

describe("side-peek comment section persistence", () => {
  it("persists collapse state independently per document anchor", () => {
    const first = panelThreadSectionSessionKey("/review", "first");
    const second = panelThreadSectionSessionKey("/review", "second");

    writePanelThreadSectionCollapsed(first, true);

    expect(readPanelThreadSectionCollapsed(first)).toBe(true);
    expect(readPanelThreadSectionCollapsed(second)).toBe(false);

    writePanelThreadSectionCollapsed(first, false);
    expect(readPanelThreadSectionCollapsed(first)).toBe(false);
  });
});

function testAnchor(id: string): AnchorRef {
  return {
    __kind: "db-anchor-ref",
    id,
    title: "Authored code",
  };
}
