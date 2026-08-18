import type { ReviewDiffFile } from "./review-diff-files";
import type { SourceSnapshot } from "./source-code-types";

export interface CodePeekDiffRange {
  file: string;
  fromLine: number;
  toLine: number;
}

type DiffOrientation = "head" | "base";

interface ParsedPatch {
  headerLines: string[];
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  header: string;
  oldStart: number;
  newStart: number;
  section: string;
  rows: ParsedHunkRow[];
}

interface ParsedHunkRow {
  marker: " " | "+" | "-";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  oldCursor: number;
  newCursor: number;
  noNewlineMarker?: string;
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
  orientation: DiffOrientation;
  contextLines?: number;
}): ReviewDiffFile | null {
  const fileRanges = mergeCodePeekDiffRanges(
    input.ranges.filter((range) => rangeMatchesDiffFile(range, input.file)),
  );
  if (fileRanges.length === 0) return null;
  if (!input.file.patch) return null;

  const parsed = parsePatch(input.file.patch);
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
  hunk: ParsedHunk;
  ranges: CodePeekDiffRange[];
  orientation: DiffOrientation;
  contextLines: number;
}): ParsedHunkRow[][] {
  const relevantIndexes = new Set<number>();
  let hasChangedRowInRange = false;

  input.hunk.rows.forEach((row, index) => {
    const anchorLine = rowAnchorLine(input.hunk.rows, index, input.orientation);
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

function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split(/\r?\n/);
  const headerLines: string[] = [];
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = parseHunkHeader(line);
    if (header) {
      current = {
        ...header,
        header: line,
        rows: [],
      };
      oldCursor = header.oldStart;
      newCursor = header.newStart;
      hunks.push(current);
      continue;
    }

    if (!current) {
      headerLines.push(line);
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      const previous = current.rows.at(-1);
      if (previous) previous.noNewlineMarker = line;
      continue;
    }

    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;

    const row: ParsedHunkRow = {
      marker,
      text: line.slice(1),
      oldLine: marker === "+" ? null : oldCursor,
      newLine: marker === "-" ? null : newCursor,
      oldCursor,
      newCursor,
    };
    current.rows.push(row);

    if (marker !== "+") oldCursor += 1;
    if (marker !== "-") newCursor += 1;
  }

  return {
    headerLines: trimTrailingBlankHeaderLine(headerLines),
    hunks,
  };
}

function parseHunkHeader(line: string): {
  oldStart: number;
  newStart: number;
  section: string;
} | null {
  const match =
    /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@(?<section>.*)$/.exec(
      line,
    );
  if (!match?.groups) return null;
  return {
    oldStart: Number(match.groups.oldStart),
    newStart: Number(match.groups.newStart),
    section: match.groups.section,
  };
}

function formatHunkSegment(
  hunk: ParsedHunk,
  rows: ParsedHunkRow[],
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
  rows: ParsedHunkRow[],
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

function rowAnchorLine(
  rows: ParsedHunkRow[],
  index: number,
  orientation: DiffOrientation,
): number | null {
  const row = rows[index];
  if (orientation === "head") {
    if (row.newLine !== null) return row.newLine;
    return adjacentLine(rows, index, "newLine");
  }

  if (row.oldLine !== null) return row.oldLine;
  return adjacentLine(rows, index, "oldLine");
}

function adjacentLine(
  rows: ParsedHunkRow[],
  index: number,
  key: "oldLine" | "newLine",
): number | null {
  for (let i = index + 1; i < rows.length; i += 1) {
    const line = rows[i][key];
    if (line !== null) return line;
  }

  for (let i = index - 1; i >= 0; i -= 1) {
    const line = rows[i][key];
    if (line !== null) return line + 1;
  }

  return 1;
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

function trimTrailingBlankHeaderLine(lines: string[]): string[] {
  if (lines.at(-1) === "") return lines.slice(0, -1);
  return lines;
}
