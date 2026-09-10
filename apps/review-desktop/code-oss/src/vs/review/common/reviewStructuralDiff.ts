/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Lossless subset of diffr's v1 domain wire used by the native experiment. */
export interface StructuralRange {
  start: { line: number; byte_column: number };
  end: { line: number; byte_column: number };
}
export interface StructuralFold {
  range: StructuralRange;
  tags: string[];
  placeholder: string;
  match_kind: "Novel" | { Unchanged: { opposite: StructuralRange } };
}
export interface StructuralPosition {
  pos: { line: number; start_col: number; end_col: number };
  kind: Record<string, { highlight: unknown }>;
}
export interface StructuralDiff {
  lhs_src: { Text: string } | "Binary";
  rhs_src: { Text: string } | "Binary";
  hunks: { lines: [number | null, number | null][]; novel_lhs: number[]; novel_rhs: number[] }[];
  aligned_rows?: [number | null, number | null][];
  lhs_folds: StructuralFold[];
  rhs_folds: StructuralFold[];
  lhs_positions: StructuralPosition[];
  rhs_positions: StructuralPosition[];
}
export interface StructuralFileEvent {
  type: "file";
  file: { old_path: string | null; new_path: string | null };
  diff: StructuralDiff;
}

/** Monaco keeps a final empty line after a newline; the wire need not mention it. */
export function structuralRows(diff: StructuralDiff): [number | null, number | null][] {
  if (diff.lhs_src === "Binary" || diff.rhs_src === "Binary") return [];
  const leftCount = diff.lhs_src.Text.split("\n").length;
  const rightCount = diff.rhs_src.Text.split("\n").length;
  const result: [number | null, number | null][] = [];
  let left = 0,
    right = 0;
  function gap(leftEnd: number, rightEnd: number) {
    while (left < leftEnd || right < rightEnd) {
      result.push([left < leftEnd ? left++ : null, right < rightEnd ? right++ : null]);
    }
  }
  for (const lines of diff.aligned_rows ? [diff.aligned_rows] : diff.hunks.map(hunk => hunk.lines)) {
    for (const [l, r] of lines) {
      // Context in neighboring hunks can overlap. Consumed rows must agree.
      if ((l === null || l < left) && (r === null || r < right)) continue;
      if ((l !== null && l < left) || (r !== null && r < right)) {
        throw new Error("diffr supplied conflicting hunk alignment.");
      }
      if ((l !== null && l >= leftCount) || (r !== null && r >= rightCount)) {
        throw new Error("diffr alignment exceeds the source.");
      }
      gap(l ?? left, r ?? right);
      result.push([l, r]);
      if (l !== null) left = l + 1;
      if (r !== null) right = r + 1;
    }
  }
  gap(leftCount, rightCount);
  return result;
}

/** Native folding retains the first source line and hides following whole lines. */
export function nativeFoldRange(
  range: StructuralRange,
): { start: number; end: number } | undefined {
  const start = range.start.line + 1;
  const end = range.end.line + (range.end.byte_column === 0 ? 0 : 1);
  return end > start ? { start, end } : undefined;
}

export function utf16Column(text: string, byteColumn: number): number {
  let bytes = 0,
    units = 0;
  for (const character of text) {
    if (bytes >= byteColumn) break;
    bytes += new TextEncoder().encode(character).length;
    units += character.length;
  }
  if (bytes !== byteColumn) throw new Error("diffr position is not on a UTF-8 boundary.");
  return units + 1;
}

/** Only engine-classified novel lines and spans receive change paint. Text inequality is layout-only. */
export function structuralHighlights(diff: StructuralDiff) {
  function side(source: StructuralDiff["lhs_src"], positions: StructuralPosition[]) {
    if (source === "Binary") return [];
    const lines = source.Text.replace(/\r\n/g, "\n").split("\n");
    return positions.filter(p => "Novel" in p.kind || "NovelWord" in p.kind).map(({ pos }) => ({
      startLineNumber: pos.line + 1,
      startColumn: utf16Column(lines[pos.line], pos.start_col),
      endLineNumber: pos.line + 1,
      endColumn: utf16Column(lines[pos.line], pos.end_col),
    }));
  }
  return {
    original: side(diff.lhs_src, diff.lhs_positions),
    modified: side(diff.rhs_src, diff.rhs_positions),
    originalLines: [...new Set(diff.hunks.flatMap(hunk => hunk.novel_lhs))].map(line => line + 1),
    modifiedLines: [...new Set(diff.hunks.flatMap(hunk => hunk.novel_rhs))].map(line => line + 1),
  };
}

/** Omitted hunk rows remain available for explicit context expansion. */
export function structuralContextGaps(diff: StructuralDiff) {
  const selected = [new Set<number>(), new Set<number>()];
  for (const hunk of diff.hunks) for (const row of hunk.lines)
    row.forEach((line, side) => { if (line !== null) selected[side].add(line); });
  const gaps: { originalStart: number; modifiedStart: number; originalCount: number; modifiedCount: number }[] = [];
  let original = 1, modified = 1;
  let gap: typeof gaps[number] | undefined;
  let mask = "";
  for (const [lhs, rhs] of structuralRows(diff)) {
    const hideLeft = lhs !== null && !selected[0].has(lhs);
    const hideRight = rhs !== null && !selected[1].has(rhs);
    const nextMask = `${hideLeft}:${hideRight}`;
    if (!hideLeft && !hideRight) { gap = undefined; mask = ""; }
    else {
      if (!gap || mask !== nextMask) {
        gap = { originalStart: original, modifiedStart: modified, originalCount: 0, modifiedCount: 0 };
        gaps.push(gap);
        mask = nextMask;
      }
      if (hideLeft) gap.originalCount++;
      if (hideRight) gap.modifiedCount++;
    }
    if (lhs !== null) original = lhs + 2;
    if (rhs !== null) modified = rhs + 2;
  }
  return gaps;
}
