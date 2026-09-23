export type WhiteboardCodePeekOrientation = "head" | "base";

export interface WhiteboardCodePeekPatch {
  headerLines: string[];
  hunks: WhiteboardCodePeekHunk[];
}

export interface WhiteboardCodePeekHunk {
  header: string;
  oldStart: number;
  newStart: number;
  section: string;
  rows: WhiteboardCodePeekHunkRow[];
}

export interface WhiteboardCodePeekHunkRow {
  marker: " " | "+" | "-";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  oldCursor: number;
  newCursor: number;
  noNewlineMarker?: string;
}

export function parseWhiteboardCodePeekPatch(
  patch: string,
): WhiteboardCodePeekPatch {
  const lines = patch.split(/\r?\n/);
  const headerLines: string[] = [];
  const hunks: WhiteboardCodePeekHunk[] = [];
  let current: WhiteboardCodePeekHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = parseWhiteboardCodePeekHunkHeader(line);

    if (header) {
      current = {
        ...header,
        header: line,
        rows: [],
      };
      oldCursor = header.oldStart + (header.oldLines === 0 ? 1 : 0);
      newCursor = header.newStart + (header.newLines === 0 ? 1 : 0);
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

    const row: WhiteboardCodePeekHunkRow = {
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
    headerLines: trimWhiteboardCodePeekHeader(headerLines),
    hunks,
  };
}

function parseWhiteboardCodePeekHunkHeader(line: string): {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  section: string;
} | null {
  const match =
    /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@(?<section>.*)$/.exec(
      line,
    );

  if (!match?.groups) return null;

  return {
    oldStart: Number(match.groups.oldStart),
    oldLines: Number(match.groups.oldLines ?? 1),
    newLines: Number(match.groups.newLines ?? 1),
    newStart: Number(match.groups.newStart),
    section: match.groups.section,
  };
}

export function whiteboardCodePeekRowAnchorLine(
  rows: WhiteboardCodePeekHunkRow[],
  index: number,
  orientation: WhiteboardCodePeekOrientation,
): number | null {
  const row = rows[index];

  if (orientation === "head") {
    if (row.newLine !== null) return row.newLine;

    return whiteboardCodePeekAdjacentLine(rows, index, "newLine");
  }

  if (row.oldLine !== null) return row.oldLine;

  return whiteboardCodePeekAdjacentLine(rows, index, "oldLine");
}

function whiteboardCodePeekAdjacentLine(
  rows: WhiteboardCodePeekHunkRow[],
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

  // A zero-context insertion/deletion has no opposite-side rows. Git
  // records the preceding line for a zero-length range; the parser advances
  // that cursor so it anchors exactly as a patch with surrounding context.
  return Math.max(
    1,
    key === "oldLine" ? rows[index].oldCursor : rows[index].newCursor,
  );
}

function trimWhiteboardCodePeekHeader(lines: string[]): string[] {
  if (lines.at(-1) === "") return lines.slice(0, -1);

  return lines;
}

/** Counts each authored entry independently, preserving overlap and side. */
export function whiteboardCodePeekRangeCounts(
  patch: string | undefined,
  ranges: readonly {
    startLine: number;
    endLine: number;
    side?: WhiteboardCodePeekOrientation;
  }[],
  defaultSide: WhiteboardCodePeekOrientation,
): { additions: number; deletions: number } | undefined {
  if (!patch) return undefined;
  const parsed = parseWhiteboardCodePeekPatch(patch);
  let additions = 0;
  let deletions = 0;

  for (const range of ranges) {
    const start = Math.min(range.startLine, range.endLine);
    const end = Math.max(range.startLine, range.endLine);

    for (const hunk of parsed.hunks) {
      hunk.rows.forEach((row, index) => {
        if (row.marker === " ") return;

        const anchor = whiteboardCodePeekRowAnchorLine(
          hunk.rows,
          index,
          range.side ?? defaultSide,
        );

        if (anchor === null || anchor < start || anchor > end) return;

        if (row.marker === "+") additions++;
        else deletions++;
      });
    }
  }

  return additions + deletions > 0 ? { additions, deletions } : undefined;
}
