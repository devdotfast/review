/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * diffr's v2 wire as the native experiment reads it. Lines are 0-based and
 * split on `\n` only; columns are byte offsets into the wire text; ranges
 * are half-open. Sides are `lhs` (base) and `rhs` (head), and a pairing
 * carries whichever sides exist.
 */
export const STRUCTURAL_WIRE_VERSION = 2;

export interface StructuralPairing<T> {
  lhs?: T;
  rhs?: T;
}
export interface StructuralProblem {
  code: string;
  message: string;
}
export interface StructuralPos {
  line: number;
  column: number;
}
export interface StructuralSpan {
  line: number;
  start_column: number;
  end_column: number;
}
export interface StructuralVisibility {
  collapsed?: boolean;
  label?: string;
}
/**
 * One range on one side. The same `id` on the other side is its
 * counterpart. Leaves tile the file in order; a fold's range is the hull of
 * its children.
 */
export type StructuralRegion = {
  id: number;
  start: StructuralPos;
  end: StructuralPos;
  tags?: string[];
  visibility?: StructuralVisibility;
} & ({ kind: "leaf"; changed?: StructuralSpan[] } | { kind: "fold"; children: StructuralRegion[] });
export interface StructuralSyntaxSpan extends StructuralSpan {
  capture: string;
}
export interface StructuralSource {
  text: string;
  syntax?: StructuralSyntaxSpan[];
  regions?: StructuralRegion[];
}
export interface StructuralLineCounts {
  added: number;
  removed: number;
}
export interface StructuralStats {
  textual: StructuralLineCounts;
  structural?: StructuralLineCounts;
  fallback?: StructuralProblem;
}
export type StructuralTextDiff = { type: "text"; stats: StructuralStats } & StructuralPairing<StructuralSource>;
export type StructuralBinaryDiff = { type: "binary" } & StructuralPairing<{ size: number }>;
export type StructuralDiff = StructuralTextDiff | StructuralBinaryDiff;
export interface StructuralFileRef {
  path: string;
  oid: string;
  mode: string;
}
export interface StructuralFileChange {
  file: StructuralPairing<StructuralFileRef>;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed";
  category?: string;
  language?: string;
  visibility?: StructuralVisibility;
}
export type StructuralEvent =
  | { type: "start"; version: number; files: StructuralFileChange[] }
  | { type: "file"; file: StructuralPairing<StructuralFileRef>; diff?: StructuralDiff; error?: StructuralProblem }
  | { type: "complete"; succeeded: number; failed: number; aborted?: StructuralProblem };

/** Review keys a file by its head path, or its base path for a deletion. */
export function structuralFilePath(file: StructuralPairing<StructuralFileRef>): string {
  const path = file.rhs?.path ?? file.lhs?.path;
  if (path === undefined) throw new Error("diffr sent a file with no side.");
  return path;
}

/** The 0-based, half-open line span a region touches. An end at column 0 does not touch its end line. */
export function regionLines(region: StructuralRegion): { start: number; end: number } {
  return { start: region.start.line, end: region.end.column === 0 ? region.end.line : region.end.line + 1 };
}

export function structuralLeaves(regions: readonly StructuralRegion[] | undefined): StructuralRegion[] {
  const leaves: StructuralRegion[] = [];
  const walk = (region: StructuralRegion) => {
    if (region.kind === "leaf") leaves.push(region);
    else for (const child of region.children) walk(child);
  };
  for (const region of regions ?? []) walk(region);
  return leaves;
}

/**
 * Every region that can hide lines, in order: folds, and leaves that start
 * collapsed (context gaps). One fold model serves both; the editor never
 * distinguishes a syntax fold from a gap.
 */
export function structuralFoldingRegions(regions: readonly StructuralRegion[] | undefined): StructuralRegion[] {
  const result: StructuralRegion[] = [];
  const walk = (region: StructuralRegion) => {
    if (region.kind === "fold") {
      result.push(region);
      for (const child of region.children) walk(child);
    } else if (region.visibility?.collapsed) {
      result.push(region);
    }
  };
  for (const region of regions ?? []) walk(region);
  return result;
}

/** Monaco keeps a final empty line after a newline; the wire need not mention it. */
function monacoLineCount(source: StructuralSource | undefined): number {
  return source ? source.text.split("\n").length : 0;
}

/**
 * Zips the two sides' leaves by id into the full row table. Paired leaves
 * yield rows line for line; an unpaired leaf, or a paired leaf whose partner
 * already went by (a move), yields one-sided rows. Rows past the last leaf
 * pair the trailing empty lines Monaco keeps.
 */
export function structuralRows(diff: StructuralTextDiff): [number | null, number | null][] {
  const lhsLeaves = structuralLeaves(diff.lhs?.regions);
  const rhsLeaves = structuralLeaves(diff.rhs?.regions);
  const leftCount = monacoLineCount(diff.lhs);
  const rightCount = monacoLineCount(diff.rhs);
  const rows: [number | null, number | null][] = [];
  let left = 0,
    right = 0;
  const push = (l: number | null, r: number | null) => {
    if ((l !== null && l !== left) || (r !== null && r !== right)) {
      throw new Error("diffr regions do not tile the file in order.");
    }
    if ((l !== null && l >= leftCount) || (r !== null && r >= rightCount)) {
      throw new Error("diffr alignment exceeds the source.");
    }
    rows.push([l, r]);
    if (l !== null) left = l + 1;
    if (r !== null) right = r + 1;
  };
  const oneSided = (leaf: StructuralRegion, side: 0 | 1) => {
    const lines = regionLines(leaf);
    for (let line = lines.start; line < lines.end; line++) push(side === 0 ? line : null, side === 1 ? line : null);
  };
  const rhsIndex = new Map(rhsLeaves.map((leaf, index) => [leaf.id, index] as const));
  let cursor = 0;
  for (const leaf of lhsLeaves) {
    const partner = rhsIndex.get(leaf.id);
    if (partner === undefined || partner < cursor) {
      oneSided(leaf, 0);
      continue;
    }
    while (cursor < partner) oneSided(rhsLeaves[cursor++], 1);
    const a = regionLines(leaf);
    const b = regionLines(rhsLeaves[partner]);
    if (a.end - a.start !== b.end - b.start) throw new Error("diffr paired regions differ in length.");
    for (let offset = 0; offset < a.end - a.start; offset++) push(a.start + offset, b.start + offset);
    cursor = partner + 1;
  }
  while (cursor < rhsLeaves.length) oneSided(rhsLeaves[cursor++], 1);
  while (left < leftCount || right < rightCount) {
    rows.push([left < leftCount ? left++ : null, right < rightCount ? right++ : null]);
  }
  return rows;
}

/**
 * Native folding keeps its start line visible and hides the lines after it.
 * A fold's header is its own first line (the signature). A collapsed leaf has
 * no header of its own, so the line above it serves, and the fold hides
 * exactly the leaf's lines; at the top of the file, or right under a fold's
 * header line (where Monaco would merge the two ranges), the leaf's first
 * line stays visible instead.
 */
export function nativeFoldRange(
  region: StructuralRegion,
  foldHeaderLines: ReadonlySet<number> = new Set(),
): { start: number; end: number } | undefined {
  const lines = regionLines(region);
  const end = lines.end;
  let start = lines.start + 1;
  if (region.kind === "leaf" && lines.start > 0 && !foldHeaderLines.has(lines.start - 1)) start = lines.start;
  return end > start ? { start, end } : undefined;
}

/** Every folding region of one side with its native range, keyed for the editor bindings. */
export function structuralFoldRanges(
  regions: readonly StructuralRegion[] | undefined,
): { region: StructuralRegion; range: { start: number; end: number } }[] {
  const foldable = structuralFoldingRegions(regions);
  const headers = new Set(foldable.filter((region) => region.kind === "fold").map((region) => regionLines(region).start));
  const result = [];
  for (const region of foldable) {
    const range = nativeFoldRange(region, headers);
    if (range) result.push({ region, range });
  }
  return result;
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

/**
 * Change paint. A line with any `changed` span in its leaf gets the light
 * whole-line tint; the spans themselves get the darker token tint. Text
 * inequality alone never paints.
 */
export function structuralHighlights(diff: StructuralTextDiff) {
  function side(source: StructuralSource | undefined) {
    if (!source) return { spans: [], lines: [] };
    const lines = source.text.replace(/\r\n/g, "\n").split("\n");
    const changedLines = new Set<number>();
    const spans = [];
    for (const leaf of structuralLeaves(source.regions)) {
      if (leaf.kind !== "leaf") continue;
      for (const span of leaf.changed ?? []) {
        changedLines.add(span.line + 1);
        spans.push({
          startLineNumber: span.line + 1,
          startColumn: utf16Column(lines[span.line], span.start_column),
          endLineNumber: span.line + 1,
          endColumn: utf16Column(lines[span.line], span.end_column),
        });
      }
    }
    return { spans, lines: [...changedLines].sort((a, b) => a - b) };
  }
  const original = side(diff.lhs);
  const modified = side(diff.rhs);
  return {
    original: original.spans,
    modified: modified.spans,
    originalLines: original.lines,
    modifiedLines: modified.lines,
  };
}
