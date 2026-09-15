/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  REVIEW_PEEK_LINE_HEIGHT,
  type ReviewPeekLineMapping,
  type ReviewPeekWindow,
} from "./reviewPeek.js";
import type {
  ReviewDiffSide,
  ReviewInlineEditorRange,
} from "./reviewProtocol.js";

export type ReviewUnifiedDiffRowKind = "unchanged" | "added" | "deleted";

export interface ReviewUnifiedDiffRow {
  readonly lineNumber: number;
  readonly kind: ReviewUnifiedDiffRowKind;
  readonly baseLine?: number;
  readonly headLine?: number;
  readonly authorSide: ReviewDiffSide;
  readonly authorLine: number;
  readonly content: string;
}

export interface ReviewUnifiedLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewUnifiedDiff {
  readonly content: string;
  readonly rows: readonly ReviewUnifiedDiffRow[];
}

export function buildReviewUnifiedDiff(
  baseLines: readonly string[],
  headLines: readonly string[],
  mappings: readonly ReviewPeekLineMapping[],
  defaultSide: ReviewDiffSide,
): ReviewUnifiedDiff {
  const rows: ReviewUnifiedDiffRow[] = [];
  let baseLine = 1;
  let headLine = 1;

  const append = (
    kind: ReviewUnifiedDiffRowKind,
    base: number | undefined,
    head: number | undefined,
  ) => {
    const authorSide =
      kind === "deleted" ? "base" : kind === "added" ? "head" : defaultSide;
    const authorLine = authorSide === "base" ? base! : head!;
    rows.push({
      lineNumber: rows.length + 1,
      kind,
      baseLine: base,
      headLine: head,
      authorSide,
      authorLine,
      content:
        kind === "deleted" ? baseLines[base! - 1]! : headLines[head! - 1]!,
    });
  };

  const appendGap = (baseEnd: number, headEnd: number) => {
    while (baseLine < baseEnd && headLine < headEnd) {
      append("unchanged", baseLine++, headLine++);
    }
    while (baseLine < baseEnd) append("deleted", baseLine++, undefined);
    while (headLine < headEnd) append("added", undefined, headLine++);
  };

  for (const mapping of mappings) {
    const baseStart = clampBoundary(
      mapping.originalStartLine,
      baseLine,
      baseLines.length + 1,
    );
    const headStart = clampBoundary(
      mapping.modifiedStartLine,
      headLine,
      headLines.length + 1,
    );
    appendGap(baseStart, headStart);

    const baseEnd = clampBoundary(
      mapping.originalEndLineExclusive,
      baseLine,
      baseLines.length + 1,
    );
    const headEnd = clampBoundary(
      mapping.modifiedEndLineExclusive,
      headLine,
      headLines.length + 1,
    );
    while (baseLine < baseEnd) append("deleted", baseLine++, undefined);
    while (headLine < headEnd) append("added", undefined, headLine++);
  }
  appendGap(baseLines.length + 1, headLines.length + 1);

  if (rows.length === 0) {
    rows.push({
      lineNumber: 1,
      kind: "unchanged",
      baseLine: 1,
      headLine: 1,
      authorSide: defaultSide,
      authorLine: 1,
      content: "",
    });
  }

  return {
    content: rows.map((row) => row.content).join("\n"),
    rows,
  };
}

export function reviewUnifiedTargetForRange(
  path: string,
  rows: readonly ReviewUnifiedDiffRow[],
  startLine: number,
  endLine: number,
): {
  readonly path: string;
  readonly side: ReviewDiffSide;
  readonly startLine: number;
  readonly endLine: number;
} | null {
  const selected = rows.slice(startLine - 1, endLine);
  const first = selected[0];
  if (!first || selected.length !== endLine - startLine + 1) return null;
  for (let index = 0; index < selected.length; index += 1) {
    const row = selected[index]!;
    if (
      row.authorSide !== first.authorSide ||
      row.authorLine !== first.authorLine + index
    ) {
      return null;
    }
  }
  return {
    path,
    side: first.authorSide,
    startLine: first.authorLine,
    endLine: selected.at(-1)!.authorLine,
  };
}

export function reviewUnifiedRangeForTarget(
  rows: readonly ReviewUnifiedDiffRow[],
  side: ReviewDiffSide,
  startLine: number,
  endLine: number,
): ReviewUnifiedLineRange | undefined {
  const lineNumbers = rows
    .filter((row) => {
      const line = side === "base" ? row.baseLine : row.headLine;
      return line !== undefined && line >= startLine && line <= endLine;
    })
    .map((row) => row.lineNumber);
  if (lineNumbers.length === 0) return undefined;
  return {
    startLine: Math.min(...lineNumbers),
    endLine: Math.max(...lineNumbers),
  };
}

export function reviewUnifiedRangesForSelections(
  rows: readonly ReviewUnifiedDiffRow[],
  ranges: readonly ReviewInlineEditorRange[],
  defaultSide: ReviewDiffSide,
): ReviewUnifiedLineRange[] {
  const mapped = ranges
    .flatMap((range) => {
      const unifiedRange = reviewUnifiedRangeForTarget(
        rows,
        range.side ?? defaultSide,
        range.startLine,
        range.endLine,
      );
      return unifiedRange ? [unifiedRange] : [];
    })
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );

  const merged: ReviewUnifiedLineRange[] = [];
  for (const range of mapped) {
    const previous = merged.at(-1);
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine: Math.max(previous.endLine, range.endLine),
    };
  }
  return merged;
}

export function reviewUnifiedWindows(
  rows: readonly ReviewUnifiedDiffRow[],
  baseWindows: readonly ReviewPeekWindow[],
  headWindows: readonly ReviewPeekWindow[],
): ReviewPeekWindow[] {
  const visible = rows
    .filter(
      (row) =>
        lineInWindows(row.baseLine, baseWindows) ||
        lineInWindows(row.headLine, headWindows),
    )
    .map((row) => row.lineNumber);
  if (visible.length === 0) return [];

  const windows: ReviewPeekWindow[] = [];
  let startLine = visible[0]!;
  let endLine = startLine;
  for (const line of visible.slice(1)) {
    if (line === endLine + 1) {
      endLine = line;
      continue;
    }
    windows.push(toWindow(startLine, endLine));
    startLine = line;
    endLine = line;
  }
  windows.push(toWindow(startLine, endLine));
  return windows;
}

function lineInWindows(
  line: number | undefined,
  windows: readonly ReviewPeekWindow[],
): boolean {
  return (
    line !== undefined &&
    windows.some((window) => line >= window.startLine && line <= window.endLine)
  );
}

function toWindow(startLine: number, endLine: number): ReviewPeekWindow {
  const lineCount = endLine - startLine + 1;
  return {
    startLine,
    endLine,
    lineCount,
    visibleLineCount: lineCount,
    height: lineCount * REVIEW_PEEK_LINE_HEIGHT,
  };
}

function clampBoundary(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, value));
}
