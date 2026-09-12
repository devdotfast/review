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
  /** Changed lines on screen under the wire's initial fold state. Always present. */
  visible: StructuralLineCounts;
  /** Present when the AST match did not run and this is a line diff. */
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

/** One file's counts: what is on screen now, what diffr found structurally, and what git counts. */
/** A hidden band on one or both sides, one-based like Monaco's diff editor. */
export interface StructuralGap {
  originalStart: number;
  modifiedStart: number;
  originalCount: number;
  modifiedCount: number;
  label: string;
  /** The region ids this band hides, per side. */
  ids: { lhs?: number; rhs?: number };
}

/**
 * The lines a collapsed region hides on its side, zero-based half-open. A
 * fold keeps its first line (the signature) visible; a leaf hides every line.
 */
export function hiddenLinesOf(region: StructuralRegion): { start: number; end: number } {
  const lines = regionLines(region);
  return region.kind === "fold" ? { start: lines.start + 1, end: lines.end } : lines;
}

/** Collapsed regions of one side, outermost first; a collapsed descendant of a collapsed region is subsumed. */
export function collapsedRegions(
  regions: readonly StructuralRegion[] | undefined,
  isCollapsed: (id: number) => boolean,
): StructuralRegion[] {
  const result: StructuralRegion[] = [];
  const walk = (region: StructuralRegion) => {
    if (isCollapsed(region.id)) {
      if (hiddenLinesOf(region).end > hiddenLinesOf(region).start) result.push(region);
      return;
    }
    if (region.kind === "fold") for (const child of region.children) walk(child);
  };
  for (const region of regions ?? []) walk(region);
  return result;
}

/**
 * Every collapsed region as a diff-editor band. Regions collapsed on both
 * sides under one id become one band; a region collapsed on one side only
 * becomes a band with a zero count on the other side, anchored where the row
 * table puts its first hidden line.
 */
export function structuralContextGaps(
  diff: StructuralTextDiff,
  isCollapsed: (side: 0 | 1, id: number) => boolean,
): StructuralGap[] {
  const rows = structuralRows(diff);
  // First row index for each source line per side, and the opposite line at or after it.
  const rowOfLeft = new Map<number, number>(), rowOfRight = new Map<number, number>();
  rows.forEach(([l, r], index) => {
    if (l !== null && !rowOfLeft.has(l)) rowOfLeft.set(l, index);
    if (r !== null && !rowOfRight.has(r)) rowOfRight.set(r, index);
  });
  const nextOpposite = (fromRow: number, side: 0 | 1): number => {
    for (let index = fromRow; index < rows.length; index++) {
      const value = rows[index][side === 0 ? 1 : 0];
      if (value !== null) return value;
    }
    return side === 0 ? monacoLineCount(diff.rhs) : monacoLineCount(diff.lhs);
  };
  const lhs = collapsedRegions(diff.lhs?.regions, (id) => isCollapsed(0, id));
  const rhs = collapsedRegions(diff.rhs?.regions, (id) => isCollapsed(1, id));
  const rhsById = new Map(rhs.map((region) => [region.id, region]));
  const usedRhs = new Set<number>();
  const gaps: StructuralGap[] = [];
  for (const left of lhs) {
    const hidden = hiddenLinesOf(left);
    const partner = rhsById.get(left.id);
    if (partner) {
      usedRhs.add(left.id);
      const right = hiddenLinesOf(partner);
      gaps.push({
        originalStart: hidden.start + 1, originalCount: hidden.end - hidden.start,
        modifiedStart: right.start + 1, modifiedCount: right.end - right.start,
        label: partner.visibility?.label || left.visibility?.label || "",
        ids: { lhs: left.id, rhs: partner.id },
      });
      continue;
    }
    const row = rowOfLeft.get(hidden.start) ?? rows.length;
    gaps.push({
      originalStart: hidden.start + 1, originalCount: hidden.end - hidden.start,
      modifiedStart: nextOpposite(row, 0) + 1, modifiedCount: 0,
      label: left.visibility?.label || "", ids: { lhs: left.id },
    });
  }
  for (const right of rhs) {
    if (usedRhs.has(right.id)) continue;
    const hidden = hiddenLinesOf(right);
    const row = rowOfRight.get(hidden.start) ?? rows.length;
    gaps.push({
      originalStart: nextOpposite(row, 1) + 1, originalCount: 0,
      modifiedStart: hidden.start + 1, modifiedCount: hidden.end - hidden.start,
      label: right.visibility?.label || "", ids: { rhs: right.id },
    });
  }
  gaps.sort((a, b) => (a.modifiedStart - b.modifiedStart) || (a.originalStart - b.originalStart));
  for (const gap of gaps) if (!gap.label) {
    const count = Math.max(gap.originalCount, gap.modifiedCount);
    gap.label = `${count} hidden line${count === 1 ? "" : "s"}`;
  }
  return gaps;
}

export interface StructuralFileCounts {
  visible: StructuralLineCounts;
  textual: StructuralLineCounts;
  fallback?: StructuralProblem;
}

function visibleChangedLines(
  source: StructuralSource | undefined,
  isCollapsed: (id: number) => boolean,
): number {
  if (!source) return 0;
  const changed = new Set<number>();
  for (const leaf of structuralLeaves(source.regions)) {
    if (leaf.kind !== "leaf") continue;
    for (const span of leaf.changed ?? []) changed.add(span.line);
  }
  for (const region of collapsedRegions(source.regions, isCollapsed)) {
    const hidden = hiddenLinesOf(region);
    for (let line = hidden.start; line < hidden.end; line++) changed.delete(line);
  }
  return changed.size;
}

/** The wire's counts as a file arrives: its own `visible` is the headline. */
export function structuralInitialCounts(diff: StructuralTextDiff): StructuralFileCounts {
  if (!diff.stats.visible) throw new Error("diffr sent stats without visible counts.");
  return { visible: diff.stats.visible, textual: diff.stats.textual, fallback: diff.stats.fallback };
}

/**
 * Changed lines that are not hidden inside a collapsed region, per side,
 * recomputed locally once the reader toggles folds. `isCollapsed` answers for
 * the region id on the given side.
 */
export function structuralVisibleCounts(
  diff: StructuralTextDiff,
  isCollapsed: (side: 0 | 1, id: number) => boolean,
): StructuralFileCounts {
  return {
    visible: {
      added: visibleChangedLines(diff.rhs, (id) => isCollapsed(1, id)),
      removed: visibleChangedLines(diff.lhs, (id) => isCollapsed(0, id)),
    },
    textual: diff.stats.textual,
    fallback: diff.stats.fallback,
  };
}

export function structuralCountsTooltip(counts: StructuralFileCounts): string {
  const row = (label: string, value: StructuralLineCounts) => `${label} +${value.added} −${value.removed}`;
  const rows = [row("visible", counts.visible), row("textual", counts.textual)];
  if (counts.fallback) rows.push(`line diff: ${counts.fallback.code}`);
  return rows.join("\n");
}
