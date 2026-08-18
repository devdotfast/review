/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  ReviewDiffFileWire,
  ReviewDiffSide,
  ReviewInlineEditorRange,
} from "./reviewProtocol.js";

export const REVIEW_PEEK_MAX_VISIBLE_LINES = 18;
export const REVIEW_PEEK_LINE_HEIGHT = 20;
export const REVIEW_PEEK_CONTEXT_LINES = 3;

export type ReviewPeekHeightMode = "capped" | "content";

export interface ReviewPeekWindow {
  startLine: number;
  endLine: number;
  lineCount: number;
  visibleLineCount: number;
  height: number;
}

export interface ReviewPeekHiddenArea {
  startLineNumber: number;
  endLineNumber: number;
}

export interface ReviewPeekLineMapping {
  originalStartLine: number;
  originalEndLineExclusive: number;
  modifiedStartLine: number;
  modifiedEndLineExclusive: number;
}

export function reviewPeekSideAvailable(
  status: ReviewDiffFileWire["status"] | undefined,
  side: ReviewDiffSide,
): boolean {
  return !(
    (side === "base" && status === "added") ||
    (side === "head" && status === "deleted")
  );
}

export function reviewPeekWindow(
  totalLines: number,
  startLine: number,
  endLine: number,
  heightMode: ReviewPeekHeightMode,
  contextLines = REVIEW_PEEK_CONTEXT_LINES,
): ReviewPeekWindow {
  if (
    !Number.isInteger(totalLines) ||
    totalLines <= 0 ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine <= 0 ||
    endLine < startLine ||
    endLine > totalLines ||
    !Number.isInteger(contextLines) ||
    contextLines < 0
  ) {
    throw new Error("CodePeek range is outside the resolved file.");
  }
  const windowStart = Math.max(1, startLine - contextLines);
  const windowEnd = Math.min(totalLines, endLine + contextLines);
  const lineCount = windowEnd - windowStart + 1;
  const visibleLineCount =
    heightMode === "content"
      ? lineCount
      : Math.min(REVIEW_PEEK_MAX_VISIBLE_LINES, lineCount);
  return {
    startLine: windowStart,
    endLine: windowEnd,
    lineCount,
    visibleLineCount,
    height: visibleLineCount * REVIEW_PEEK_LINE_HEIGHT,
  };
}

export function reviewPeekWindows(
  totalLines: number,
  ranges: readonly ReviewInlineEditorRange[],
  heightMode: ReviewPeekHeightMode,
  contextLines = REVIEW_PEEK_CONTEXT_LINES,
): ReviewPeekWindow[] {
  if (ranges.length === 0) {
    throw new Error("CodePeek requires at least one range.");
  }
  return mergeReviewPeekWindows(
    ranges.map((range) =>
      reviewPeekWindow(
        totalLines,
        range.startLine,
        range.endLine,
        heightMode,
        contextLines,
      ),
    ),
    heightMode,
  );
}

export function reviewPeekWindowsLineCount(
  windows: readonly ReviewPeekWindow[],
): number {
  return windows.reduce((total, window) => total + window.lineCount, 0);
}

/**
 * Height bound for a multi-diff peek body in unmeasured states: before the
 * peek windows land, while the inner editors have no model, and always in
 * capped mode. The widget's getContentHeight() is never trustworthy for a
 * windowed peek — the diff editor keeps alignment view zones for every hunk
 * in the file, and setHiddenAreas removes lines but not those zones — so a
 * real measurement must come from reviewPeekWindowsRenderedHeight instead,
 * and this bound caps anything else. Summing both windows over-estimates
 * side-by-side rendering but covers the unified view, where deleted lines
 * render as view zones in the modified editor; over-estimating a bound for
 * an unmeasured state is harmless, under-estimating would clip.
 */
export function reviewPeekMultiDiffBodyHeightLimit(
  heightMode: ReviewPeekHeightMode,
  originalWindows: readonly ReviewPeekWindow[],
  modifiedWindows: readonly ReviewPeekWindow[],
): number {
  if (heightMode !== "content") {
    return REVIEW_PEEK_MAX_VISIBLE_LINES * REVIEW_PEEK_LINE_HEIGHT;
  }
  return (
    (reviewPeekWindowsLineCount(originalWindows) +
      reviewPeekWindowsLineCount(modifiedWindows)) *
    REVIEW_PEEK_LINE_HEIGHT
  );
}

export function reviewPeekCappedHeight(
  measuredHeight: number,
  commentZoneHeight: number,
): number {
  const cap = REVIEW_PEEK_MAX_VISIBLE_LINES * REVIEW_PEEK_LINE_HEIGHT;
  const contentHeight = Math.max(0, measuredHeight - commentZoneHeight);
  return Math.min(cap, contentHeight) + commentZoneHeight;
}

/** The subset of ICodeEditor that window measurement needs. */
export interface ReviewPeekRenderedEditor {
  getModel(): unknown;
  getTopForLineNumber(lineNumber: number): number;
  getBottomForLineNumber(lineNumber: number): number;
}

/**
 * Total height of peek windows as actually rendered by an editor. Each
 * window is measured independently so hidden gaps do not inflate the result.
 * Wrapped lines and in-window view zones are included; alignment view zones
 * outside the windows are excluded. Returns undefined when the editor cannot
 * be measured yet.
 */
export function reviewPeekWindowsRenderedHeight(
  editor: ReviewPeekRenderedEditor,
  windows: readonly ReviewPeekWindow[],
): number | undefined {
  if (!editor.getModel() || windows.length === 0) return undefined;
  let height = 0;
  for (const window of windows) {
    const top = editor.getTopForLineNumber(window.startLine);
    const bottom = editor.getBottomForLineNumber(window.endLine);
    if (bottom <= top) return undefined;
    height += bottom - top;
  }
  return height;
}
export function reviewPeekHiddenAreas(
  totalLines: number,
  windows: readonly ReviewPeekWindow[],
): ReviewPeekHiddenArea[] {
  const hidden: ReviewPeekHiddenArea[] = [];
  let nextVisibleLine = 1;
  for (const window of windows) {
    if (window.startLine > nextVisibleLine) {
      hidden.push({
        startLineNumber: nextVisibleLine,
        endLineNumber: window.startLine - 1,
      });
    }
    nextVisibleLine = Math.max(nextVisibleLine, window.endLine + 1);
  }
  if (nextVisibleLine <= totalLines) {
    hidden.push({
      startLineNumber: nextVisibleLine,
      endLineNumber: totalLines,
    });
  }
  return hidden;
}

export function reviewPeekLineMappings(
  patch: string,
): ReviewPeekLineMapping[] {
  const mappings: ReviewPeekLineMapping[] = [];
  let originalLine = 0;
  let modifiedLine = 0;
  let inHunk = false;
  let changeStart: { original: number; modified: number } | undefined;

  const finishChange = () => {
    if (!changeStart) return;
    mappings.push({
      originalStartLine: changeStart.original,
      originalEndLineExclusive: originalLine,
      modifiedStartLine: changeStart.modified,
      modifiedEndLineExclusive: modifiedLine,
    });
    changeStart = undefined;
  };

  for (const row of patch.split(/\r?\n/)) {
    const header =
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      finishChange();
      originalLine = Number(header[1]);
      modifiedLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("\\ No newline at end of file")) continue;
    const marker = row[0];
    if (marker === " ") {
      finishChange();
      originalLine += 1;
      modifiedLine += 1;
    } else if (marker === "-" || marker === "+") {
      changeStart ??= { original: originalLine, modified: modifiedLine };
      if (marker === "-") originalLine += 1;
      else modifiedLine += 1;
    }
  }
  finishChange();
  return mappings;
}

export function flipReviewPeekLineMappings(
  mappings: readonly ReviewPeekLineMapping[],
): ReviewPeekLineMapping[] {
  return mappings.map((mapping) => ({
    originalStartLine: mapping.modifiedStartLine,
    originalEndLineExclusive: mapping.modifiedEndLineExclusive,
    modifiedStartLine: mapping.originalStartLine,
    modifiedEndLineExclusive: mapping.originalEndLineExclusive,
  }));
}

export function mappedReviewPeekWindow(
  destinationLineCount: number,
  sourceWindow: ReviewPeekWindow,
  mappings: readonly ReviewPeekLineMapping[],
): ReviewPeekWindow {
  const startLine = clampLine(
    mapReviewPeekLine(sourceWindow.startLine, mappings, "start"),
    destinationLineCount,
  );
  const endLine = Math.max(
    startLine,
    clampLine(
      mapReviewPeekLine(sourceWindow.endLine, mappings, "end"),
      destinationLineCount,
    ),
  );
  return reviewPeekWindow(
    destinationLineCount,
    startLine,
    endLine,
    "content",
    0,
  );
}

export function mappedReviewPeekWindows(
  destinationLineCount: number,
  sourceWindows: readonly ReviewPeekWindow[],
  mappings: readonly ReviewPeekLineMapping[],
): ReviewPeekWindow[] {
  return mergeReviewPeekWindows(
    sourceWindows.map((window) =>
      mappedReviewPeekWindow(destinationLineCount, window, mappings),
    ),
    "content",
  );
}

export function reviewPeekDiffWindows(
  originalLineCount: number,
  modifiedLineCount: number,
  ranges: readonly ReviewInlineEditorRange[],
  defaultSide: ReviewDiffSide,
  baseToHeadMappings: readonly ReviewPeekLineMapping[],
): {
  readonly original: readonly ReviewPeekWindow[];
  readonly modified: readonly ReviewPeekWindow[];
} {
  const baseRanges = ranges.filter(
    (range) => (range.side ?? defaultSide) === "base",
  );
  const headRanges = ranges.filter(
    (range) => (range.side ?? defaultSide) === "head",
  );
  const originalSelections =
    baseRanges.length > 0
      ? reviewPeekWindows(originalLineCount, baseRanges, "content")
      : [];
  const modifiedSelections =
    headRanges.length > 0
      ? reviewPeekWindows(modifiedLineCount, headRanges, "content")
      : [];
  const originalFromHead = mappedReviewPeekWindows(
    originalLineCount,
    modifiedSelections,
    flipReviewPeekLineMappings(baseToHeadMappings),
  );
  const modifiedFromBase = mappedReviewPeekWindows(
    modifiedLineCount,
    originalSelections,
    baseToHeadMappings,
  );
  return {
    original: mergeReviewPeekWindows(
      [...originalSelections, ...originalFromHead],
      "content",
    ),
    modified: mergeReviewPeekWindows(
      [...modifiedSelections, ...modifiedFromBase],
      "content",
    ),
  };
}

function mergeReviewPeekWindows(
  windows: readonly ReviewPeekWindow[],
  heightMode: ReviewPeekHeightMode,
): ReviewPeekWindow[] {
  const sorted = [...windows].sort(
    (left, right) => left.startLine - right.startLine,
  );
  const merged: ReviewPeekWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous || window.startLine > previous.endLine + 1) {
      merged.push(window);
      continue;
    }
    const endLine = Math.max(previous.endLine, window.endLine);
    const lineCount = endLine - previous.startLine + 1;
    const visibleLineCount =
      heightMode === "content"
        ? lineCount
        : Math.min(REVIEW_PEEK_MAX_VISIBLE_LINES, lineCount);
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine,
      lineCount,
      visibleLineCount,
      height: visibleLineCount * REVIEW_PEEK_LINE_HEIGHT,
    };
  }
  return merged;
}

function mapReviewPeekLine(
  line: number,
  mappings: readonly ReviewPeekLineMapping[],
  edge: "start" | "end",
): number {
  const mapping = mappings.findLast(
    (candidate) => candidate.originalStartLine <= line,
  );
  if (!mapping) return line;
  if (mapping.originalEndLineExclusive <= line) {
    return (
      line -
      mapping.originalEndLineExclusive +
      mapping.modifiedEndLineExclusive
    );
  }
  return edge === "start"
    ? mapping.modifiedStartLine
    : Math.max(
        mapping.modifiedStartLine,
        mapping.modifiedEndLineExclusive - 1,
      );
}

function clampLine(line: number, totalLines: number): number {
  return Math.max(1, Math.min(line, totalLines));
}
