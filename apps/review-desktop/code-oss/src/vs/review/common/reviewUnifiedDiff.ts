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
  GitLabTextDiffRow,
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
  readonly commentingRanges: readonly ReviewUnifiedLineRange[];
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
    commentingRanges: [{ startLine: 1, endLine: rows.length }],
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

export function reviewUnifiedPositionRowsForRange(
  rows: readonly ReviewUnifiedDiffRow[],
  startLine: number,
  endLine: number,
): {
  readonly start: GitLabTextDiffRow;
  readonly end: GitLabTextDiffRow;
} | null {
  const selected = rows.slice(startLine - 1, endLine);
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last || selected.length !== endLine - startLine + 1) {
    return null;
  }
  return {
    start: {
      old_line: first.baseLine ?? null,
      new_line: first.headLine ?? null,
    },
    end: { old_line: last.baseLine ?? null, new_line: last.headLine ?? null },
  };
}

export function reviewDiffPositionRowsForRange(
  mappings: readonly ReviewPeekLineMapping[],
  side: ReviewDiffSide,
  startLine: number,
  endLine: number,
): { readonly start: GitLabTextDiffRow; readonly end: GitLabTextDiffRow } {
  return {
    start: reviewDiffPositionRowForLine(mappings, side, startLine),
    end: reviewDiffPositionRowForLine(mappings, side, endLine),
  };
}

export function reviewDiffSideRangeForPositionRows(
  mappings: readonly ReviewPeekLineMapping[],
  side: ReviewDiffSide,
  start: GitLabTextDiffRow,
  end: GitLabTextDiffRow,
): ReviewUnifiedLineRange | undefined {
  const segments = reviewDiffRowSegments(mappings, start, end);
  const startOrdinal = positionRowOrdinal(segments, start);
  const endOrdinal = positionRowOrdinal(segments, end);
  if (startOrdinal === undefined || endOrdinal === undefined) return undefined;
  const firstOrdinal = Math.min(startOrdinal, endOrdinal);
  const lastOrdinal = Math.max(startOrdinal, endOrdinal);
  const selectedLines: number[] = [];
  for (const segment of segments) {
    const sideStart = side === "base" ? segment.baseStart : segment.headStart;
    if (sideStart === undefined) continue;
    const segmentEnd = segment.ordinalStart + segment.length - 1;
    const overlapStart = Math.max(firstOrdinal, segment.ordinalStart);
    const overlapEnd = Math.min(lastOrdinal, segmentEnd);
    if (overlapStart > overlapEnd) continue;
    selectedLines.push(
      sideStart + overlapStart - segment.ordinalStart,
      sideStart + overlapEnd - segment.ordinalStart,
    );
  }
  if (selectedLines.length === 0) return undefined;
  return {
    startLine: Math.min(...selectedLines),
    endLine: Math.max(...selectedLines),
  };
}

export function reviewUnifiedRangeForPositionRows(
  rows: readonly ReviewUnifiedDiffRow[],
  start: GitLabTextDiffRow,
  end: GitLabTextDiffRow,
): ReviewUnifiedLineRange | undefined {
  const startIndex = rows.findIndex((row) => positionRowMatches(row, start));
  if (startIndex < 0) return undefined;
  const endOffset = rows
    .slice(startIndex)
    .findIndex((row) => positionRowMatches(row, end));
  if (endOffset < 0) return undefined;
  return {
    startLine: rows[startIndex]!.lineNumber,
    endLine: rows[startIndex + endOffset]!.lineNumber,
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

function reviewDiffPositionRowForLine(
  mappings: readonly ReviewPeekLineMapping[],
  side: ReviewDiffSide,
  line: number,
): GitLabTextDiffRow {
  let delta = 0;
  for (const mapping of mappings) {
    const sideStart =
      side === "base" ? mapping.originalStartLine : mapping.modifiedStartLine;
    const sideEnd =
      side === "base"
        ? mapping.originalEndLineExclusive
        : mapping.modifiedEndLineExclusive;
    if (line < sideStart) {
      return side === "base"
        ? { old_line: line, new_line: line + delta }
        : { old_line: line - delta, new_line: line };
    }
    if (line < sideEnd) {
      return side === "base"
        ? { old_line: line, new_line: null }
        : { old_line: null, new_line: line };
    }
    delta +=
      mapping.modifiedEndLineExclusive -
      mapping.modifiedStartLine -
      (mapping.originalEndLineExclusive - mapping.originalStartLine);
  }
  return side === "base"
    ? { old_line: line, new_line: line + delta }
    : { old_line: line - delta, new_line: line };
}

function positionRowMatches(
  row: ReviewUnifiedDiffRow,
  position: GitLabTextDiffRow,
): boolean {
  return (
    (position.old_line === null || row.baseLine === position.old_line) &&
    (position.new_line === null || row.headLine === position.new_line)
  );
}

interface ReviewDiffRowSegment {
  readonly ordinalStart: number;
  readonly length: number;
  readonly baseStart?: number;
  readonly headStart?: number;
}

function reviewDiffRowSegments(
  mappings: readonly ReviewPeekLineMapping[],
  start: GitLabTextDiffRow,
  end: GitLabTextDiffRow,
): ReviewDiffRowSegment[] {
  const segments: ReviewDiffRowSegment[] = [];
  let baseLine = 1;
  let headLine = 1;
  let ordinal = 1;
  const append = (
    length: number,
    baseStart?: number,
    headStart?: number,
  ) => {
    if (length <= 0) return;
    segments.push({ ordinalStart: ordinal, length, baseStart, headStart });
    ordinal += length;
  };
  const appendGap = (baseEnd: number, headEnd: number) => {
    const unchanged = Math.min(baseEnd - baseLine, headEnd - headLine);
    append(unchanged, baseLine, headLine);
    baseLine += unchanged;
    headLine += unchanged;
    append(baseEnd - baseLine, baseLine, undefined);
    baseLine = baseEnd;
    append(headEnd - headLine, undefined, headLine);
    headLine = headEnd;
  };

  for (const mapping of mappings) {
    const baseStart = Math.max(baseLine, mapping.originalStartLine);
    const headStart = Math.max(headLine, mapping.modifiedStartLine);
    appendGap(baseStart, headStart);
    const baseEnd = Math.max(baseStart, mapping.originalEndLineExclusive);
    const headEnd = Math.max(headStart, mapping.modifiedEndLineExclusive);
    append(baseEnd - baseStart, baseStart, undefined);
    append(headEnd - headStart, undefined, headStart);
    baseLine = baseEnd;
    headLine = headEnd;
  }

  const finalBaseLine =
    Math.max(start.old_line ?? 0, end.old_line ?? 0, baseLine - 1) + 1;
  const finalHeadLine =
    Math.max(start.new_line ?? 0, end.new_line ?? 0, headLine - 1) + 1;
  appendGap(finalBaseLine, finalHeadLine);
  return segments;
}

function positionRowOrdinal(
  segments: readonly ReviewDiffRowSegment[],
  position: GitLabTextDiffRow,
): number | undefined {
  if (position.old_line === null && position.new_line === null) {
    return undefined;
  }
  for (const segment of segments) {
    let offset: number | undefined;
    if (position.old_line !== null) {
      if (segment.baseStart === undefined) continue;
      offset = position.old_line - segment.baseStart;
      if (offset < 0 || offset >= segment.length) continue;
    }
    if (position.new_line !== null) {
      if (segment.headStart === undefined) continue;
      const headOffset = position.new_line - segment.headStart;
      if (headOffset < 0 || headOffset >= segment.length) continue;
      if (offset !== undefined && offset !== headOffset) continue;
      offset = headOffset;
    }
    if (offset !== undefined) return segment.ordinalStart + offset;
  }
  return undefined;
}
