/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  WhiteboardDiffFileWire,
  WhiteboardDiffSide,
  WhiteboardInlineEditorRange,
} from "./whiteboardProtocol.js";

export const WHITEBOARD_PEEK_MAX_VISIBLE_LINES = 18;
export const WHITEBOARD_PEEK_LINE_HEIGHT = 20;
const WHITEBOARD_PEEK_CONTEXT_LINES = 3;

export type WhiteboardPeekHeightMode = "capped" | "content";

export interface WhiteboardPeekWindow {
  startLine: number;
  endLine: number;
  lineCount: number;
  visibleLineCount: number;
  height: number;
}

export interface WhiteboardPeekHiddenArea {
  startLineNumber: number;
  endLineNumber: number;
}

export interface WhiteboardPeekLineMapping {
  originalStartLine: number;
  originalEndLineExclusive: number;
  modifiedStartLine: number;
  modifiedEndLineExclusive: number;
}

export function whiteboardPeekSideAvailable(
  status: WhiteboardDiffFileWire["status"] | undefined,
  side: WhiteboardDiffSide,
): boolean {
  return !(
    (side === "base" && status === "added") ||
    (side === "head" && status === "deleted")
  );
}

export function whiteboardPeekWindow(
  totalLines: number,
  startLine: number,
  endLine: number,
  heightMode: WhiteboardPeekHeightMode,
  contextLines = WHITEBOARD_PEEK_CONTEXT_LINES,
): WhiteboardPeekWindow {
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
      : Math.min(WHITEBOARD_PEEK_MAX_VISIBLE_LINES, lineCount);
  return {
    startLine: windowStart,
    endLine: windowEnd,
    lineCount,
    visibleLineCount,
    height: visibleLineCount * WHITEBOARD_PEEK_LINE_HEIGHT,
  };
}

export function whiteboardPeekWindows(
  totalLines: number,
  ranges: readonly WhiteboardInlineEditorRange[],
  heightMode: WhiteboardPeekHeightMode,
  contextLines = WHITEBOARD_PEEK_CONTEXT_LINES,
): WhiteboardPeekWindow[] {
  if (ranges.length === 0) {
    throw new Error("CodePeek requires at least one range.");
  }
  return mergeWhiteboardPeekWindows(
    ranges.map((range) =>
      whiteboardPeekWindow(
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

export function whiteboardPeekWindowsLineCount(
  windows: readonly WhiteboardPeekWindow[],
): number {
  return windows.reduce((total, window) => total + window.lineCount, 0);
}

export function whiteboardPeekCappedHeight(measuredHeight: number): number {
  return Math.min(
    WHITEBOARD_PEEK_MAX_VISIBLE_LINES * WHITEBOARD_PEEK_LINE_HEIGHT,
    Math.max(0, measuredHeight),
  );
}

/** The subset of ICodeEditor that window measurement needs. */
interface WhiteboardPeekRenderedEditor {
  getModel(): unknown;
  getTopForLineNumber(lineNumber: number, includeViewZones?: boolean): number;
  getBottomForLineNumber(lineNumber: number, includeViewZones?: boolean): number;
}

/**
 * Total height of peek windows as actually rendered by an editor. Each
 * window is measured independently so hidden gaps do not inflate the result.
 * Wrapped lines and in-window view zones are included; alignment view zones
 * outside the windows are excluded. Returns undefined when the editor cannot
 * be measured yet.
 */
export function whiteboardPeekWindowsRenderedHeight(
  editor: WhiteboardPeekRenderedEditor,
  windows: readonly WhiteboardPeekWindow[],
): number | undefined {
  if (!editor.getModel() || windows.length === 0) return undefined;
  let height = 0;
  for (const window of windows) {
    // Monaco excludes view zones by default. Inline diffs render deleted
    // lines as view zones, so they must count toward the window height.
    const top = editor.getTopForLineNumber(window.startLine, true);
    const bottom = editor.getBottomForLineNumber(window.endLine, true);
    if (bottom <= top) return undefined;
    height += bottom - top;
  }
  return height;
}
export function whiteboardPeekHiddenAreas(
  totalLines: number,
  windows: readonly WhiteboardPeekWindow[],
): WhiteboardPeekHiddenArea[] {
  const hidden: WhiteboardPeekHiddenArea[] = [];
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

export function whiteboardPeekLineMappings(
  patch: string,
): WhiteboardPeekLineMapping[] {
  const mappings: WhiteboardPeekLineMapping[] = [];
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

function flipWhiteboardPeekLineMappings(
  mappings: readonly WhiteboardPeekLineMapping[],
): WhiteboardPeekLineMapping[] {
  return mappings.map((mapping) => ({
    originalStartLine: mapping.modifiedStartLine,
    originalEndLineExclusive: mapping.modifiedEndLineExclusive,
    modifiedStartLine: mapping.originalStartLine,
    modifiedEndLineExclusive: mapping.originalEndLineExclusive,
  }));
}

function mappedWhiteboardPeekWindow(
  destinationLineCount: number,
  sourceWindow: WhiteboardPeekWindow,
  mappings: readonly WhiteboardPeekLineMapping[],
): WhiteboardPeekWindow {
  const startLine = clampLine(
    mapWhiteboardPeekLine(sourceWindow.startLine, mappings, "start"),
    destinationLineCount,
  );
  const endLine = Math.max(
    startLine,
    clampLine(
      mapWhiteboardPeekLine(sourceWindow.endLine, mappings, "end"),
      destinationLineCount,
    ),
  );
  return whiteboardPeekWindow(
    destinationLineCount,
    startLine,
    endLine,
    "content",
    0,
  );
}

function mappedWhiteboardPeekWindows(
  destinationLineCount: number,
  sourceWindows: readonly WhiteboardPeekWindow[],
  mappings: readonly WhiteboardPeekLineMapping[],
): WhiteboardPeekWindow[] {
  return mergeWhiteboardPeekWindows(
    sourceWindows.map((window) =>
      mappedWhiteboardPeekWindow(destinationLineCount, window, mappings),
    ),
    "content",
  );
}

export function whiteboardPeekDiffWindows(
  originalLineCount: number,
  modifiedLineCount: number,
  ranges: readonly WhiteboardInlineEditorRange[],
  defaultSide: WhiteboardDiffSide,
  baseToHeadMappings: readonly WhiteboardPeekLineMapping[],
): {
  readonly original: readonly WhiteboardPeekWindow[];
  readonly modified: readonly WhiteboardPeekWindow[];
} {
  const baseRanges = ranges.filter(
    (range) => (range.side ?? defaultSide) === "base",
  );
  const headRanges = ranges.filter(
    (range) => (range.side ?? defaultSide) === "head",
  );
  const originalSelections =
    baseRanges.length > 0
      ? whiteboardPeekWindows(originalLineCount, baseRanges, "content")
      : [];
  const modifiedSelections =
    headRanges.length > 0
      ? whiteboardPeekWindows(modifiedLineCount, headRanges, "content")
      : [];
  const originalFromHead = mappedWhiteboardPeekWindows(
    originalLineCount,
    modifiedSelections,
    flipWhiteboardPeekLineMappings(baseToHeadMappings),
  );
  const modifiedFromBase = mappedWhiteboardPeekWindows(
    modifiedLineCount,
    originalSelections,
    baseToHeadMappings,
  );
  return {
    original: mergeWhiteboardPeekWindows(
      [...originalSelections, ...originalFromHead],
      "content",
    ),
    modified: mergeWhiteboardPeekWindows(
      [...modifiedSelections, ...modifiedFromBase],
      "content",
    ),
  };
}

function mergeWhiteboardPeekWindows(
  windows: readonly WhiteboardPeekWindow[],
  heightMode: WhiteboardPeekHeightMode,
): WhiteboardPeekWindow[] {
  const sorted = [...windows].sort(
    (left, right) => left.startLine - right.startLine,
  );
  const merged: WhiteboardPeekWindow[] = [];
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
        : Math.min(WHITEBOARD_PEEK_MAX_VISIBLE_LINES, lineCount);
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine,
      lineCount,
      visibleLineCount,
      height: visibleLineCount * WHITEBOARD_PEEK_LINE_HEIGHT,
    };
  }
  return merged;
}

function mapWhiteboardPeekLine(
  line: number,
  mappings: readonly WhiteboardPeekLineMapping[],
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
