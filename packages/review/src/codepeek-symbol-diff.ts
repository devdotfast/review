import {
  type ReviewCodePeekHunk,
  type ReviewCodePeekHunkRow,
  type ReviewCodePeekOrientation,
  parseReviewCodePeekPatch,
  reviewCodePeekRowAnchorLine,
} from "@dev.fast/review-protocol";

import type { ReviewDiffFile } from "./review-diff-files";
import type { SourceSnapshot } from "./source-code-types";

export interface CodePeekDiffRange {
  file: string;
  fromLine: number;
  toLine: number;
}

export function codePeekRootSourceRanges(
  snapshot: SourceSnapshot,
): CodePeekDiffRange[] {
  const rootSourceIds = snapshot.roots.map((root) => root.sourceId);

  const sourceIds =
    rootSourceIds.length > 0 ? rootSourceIds : Object.keys(snapshot.resolved);

  const ranges = sourceIds
    .map((sourceId) => snapshot.resolved[sourceId]?.source)
    .filter((source) => source && source.file.trim().length > 0)
    .map((source) => ({
      file: source.file,
      fromLine: Math.min(source.line, source.endLine),
      toLine: Math.max(source.line, source.endLine),
    }));

  return mergeCodePeekDiffRanges(ranges);
}

export function sliceReviewDiffFileToCodePeekRanges(input: {
  file: ReviewDiffFile;
  ranges: CodePeekDiffRange[];
  orientation: ReviewCodePeekOrientation;
  contextLines?: number;
}): ReviewDiffFile | null {
  const fileRanges = mergeCodePeekDiffRanges(
    input.ranges.filter((range) => rangeMatchesDiffFile(range, input.file)),
  );

  if (fileRanges.length === 0) return null;

  if (!input.file.patch) return null;

  const parsed = parseReviewCodePeekPatch(input.file.patch);
  const contextLines = input.contextLines ?? 3;
  const hunkSections: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const hunk of parsed.hunks) {
    const segments = sliceHunkToRanges({
      hunk,
      ranges: fileRanges,
      orientation: input.orientation,
      contextLines,
    });

    for (const segment of segments) {
      const section = formatHunkSegment(hunk, segment);

      if (!section) continue;
      additions += segment.filter((row) => row.marker === "+").length;
      deletions += segment.filter((row) => row.marker === "-").length;
      hunkSections.push(section);
    }
  }

  if (hunkSections.length === 0 || additions + deletions === 0) return null;

  return {
    ...input.file,
    additions,
    deletions,
    patch: [...parsed.headerLines, ...hunkSections].join("\n"),
  };
}

function sliceHunkToRanges(input: {
  hunk: ReviewCodePeekHunk;
  ranges: CodePeekDiffRange[];
  orientation: ReviewCodePeekOrientation;
  contextLines: number;
}): ReviewCodePeekHunkRow[][] {
  const relevantIndexes = new Set<number>();
  let hasChangedRowInRange = false;

  input.hunk.rows.forEach((row, index) => {
    const anchorLine = reviewCodePeekRowAnchorLine(
      input.hunk.rows,
      index,
      input.orientation,
    );

    if (anchorLine === null) return;

    const inRange = input.ranges.some((range) =>
      lineIntersectsRange(anchorLine, range.fromLine, range.toLine),
    );

    if (inRange && row.marker !== " ") hasChangedRowInRange = true;

    const inContextRange = input.ranges.some((range) =>
      lineIntersectsRange(
        anchorLine,
        range.fromLine - input.contextLines,
        range.toLine + input.contextLines,
      ),
    );

    if (inContextRange) relevantIndexes.add(index);
  });

  if (!hasChangedRowInRange || relevantIndexes.size === 0) return [];

  return contiguousSegments([...relevantIndexes].sort((a, b) => a - b)).map(
    (indexes) => indexes.map((index) => input.hunk.rows[index]),
  );
}

function formatHunkSegment(
  hunk: ReviewCodePeekHunk,
  rows: ReviewCodePeekHunkRow[],
): string | null {
  if (rows.length === 0) return null;

  const oldCount = rows.filter((row) => row.marker !== "+").length;
  const newCount = rows.filter((row) => row.marker !== "-").length;
  const oldStart = hunkRangeStart(rows, "old", oldCount);
  const newStart = hunkRangeStart(rows, "new", newCount);

  const header = `@@ -${formatHunkRange(oldStart, oldCount)} +${formatHunkRange(
    newStart,
    newCount,
  )} @@${hunk.section}`;

  const rowLines = rows.flatMap((row) => [
    `${row.marker}${row.text}`,
    ...(row.noNewlineMarker ? [row.noNewlineMarker] : []),
  ]);

  return [header, ...rowLines].join("\n");
}

function hunkRangeStart(
  rows: ReviewCodePeekHunkRow[],
  side: "old" | "new",
  count: number,
): number {
  const firstLine =
    side === "old"
      ? rows.find((row) => row.oldLine !== null)?.oldLine
      : rows.find((row) => row.newLine !== null)?.newLine;

  if (firstLine !== undefined && firstLine !== null) return firstLine;

  const firstRow = rows[0];

  if (count === 0) {
    const cursor = side === "old" ? firstRow.oldCursor : firstRow.newCursor;

    return Math.max(0, cursor - 1);
  }

  return side === "old" ? firstRow.oldCursor : firstRow.newCursor;
}

function formatHunkRange(start: number, count: number): string {
  if (count === 1) return String(start);

  return `${start},${count}`;
}

function contiguousSegments(indexes: number[]): number[][] {
  const segments: number[][] = [];

  for (const index of indexes) {
    const current = segments.at(-1);

    if (current && current.at(-1) === index - 1) {
      current.push(index);
    } else {
      segments.push([index]);
    }
  }

  return segments;
}

function mergeCodePeekDiffRanges(
  ranges: CodePeekDiffRange[],
): CodePeekDiffRange[] {
  const byFile = new Map<string, CodePeekDiffRange[]>();

  for (const range of ranges) {
    const fileRanges = byFile.get(range.file) ?? [];
    fileRanges.push(range);
    byFile.set(range.file, fileRanges);
  }

  return [...byFile.entries()].flatMap(([file, fileRanges]) => {
    const sorted = fileRanges
      .map((range) => ({
        file,
        fromLine: Math.min(range.fromLine, range.toLine),
        toLine: Math.max(range.fromLine, range.toLine),
      }))
      .sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);

    const merged: CodePeekDiffRange[] = [];

    for (const range of sorted) {
      const current = merged.at(-1);

      if (current && range.fromLine <= current.toLine + 1) {
        current.toLine = Math.max(current.toLine, range.toLine);
      } else {
        merged.push({ ...range });
      }
    }

    return merged;
  });
}

function rangeMatchesDiffFile(
  range: CodePeekDiffRange,
  file: ReviewDiffFile,
): boolean {
  return range.file === file.path || range.file === file.previousPath;
}

function lineIntersectsRange(
  line: number,
  fromLine: number,
  toLine: number,
): boolean {
  return line >= fromLine && line <= toLine;
}
