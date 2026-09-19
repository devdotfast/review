import { structuralChangeCounts } from "./reviewProtocol.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
  StructuralPairing, StructuralFileRef, StructuralRegion, StructuralSource,
  StructuralLineCounts, StructuralProblem, StructuralDiff,
} from "./reviewProtocol.js";
export type {
  StructuralPairing, StructuralProblem, StructuralPos, StructuralSpan,
  StructuralVisibility, StructuralRegion, StructuralSyntaxSpan, StructuralSource,
  StructuralLineCounts, StructuralStats, StructuralDiff, StructuralFileRef,
  StructuralFileChange,
} from "./reviewProtocol.js";
export { STRUCTURAL_DIFF_WIRE_VERSION as STRUCTURAL_WIRE_VERSION } from "./reviewProtocol.js";
export type { StructuralDiffEvent as StructuralEvent } from "./reviewProtocol.js";
export type StructuralLeaf = Extract<StructuralRegion, { kind: "leaf" }>;
export type StructuralFold = Extract<StructuralRegion, { kind: "fold" }>;
export type StructuralTextDiff = Extract<StructuralDiff, { type: "text" }>;
export type StructuralBinaryDiff = Extract<StructuralDiff, { type: "binary" }>;

/** Review keys a file by its head path, or its base path for a deletion. */
export function structuralFilePath(file: StructuralPairing<StructuralFileRef>): string {
  return file.rhs?.path ?? file.lhs!.path;
}

/** The 0-based, half-open line span a region touches. An end at column 0 does not touch its end line. */
export function regionLines(region: StructuralRegion): { start: number; end: number } {
  return { start: region.start.line, end: region.end.column === 0 ? region.end.line : region.end.line + 1 };
}

export function structuralLeaves(regions: readonly StructuralRegion[] | undefined): StructuralLeaf[] {
  const leaves: StructuralLeaf[] = [];
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
 * Zips the two sides' leaves by `alignment_id` into the full row table. Paired leaves
 * yield rows line for line, in the same order on both sides; an unpaired leaf
 * yields one-sided rows. Rows past the last leaf pair the trailing empty
 * lines Monaco keeps.
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
    rows.push([l, r]);
    if (l !== null) left = l + 1;
    if (r !== null) right = r + 1;
  };
  const oneSided = (leaf: StructuralLeaf, side: 0 | 1) => {
    const lines = regionLines(leaf);
    for (let line = lines.start; line < lines.end; line++) push(side === 0 ? line : null, side === 1 ? line : null);
  };
  const rhsIndex = new Map(rhsLeaves.map((leaf, index) => [leaf.alignment_id, index] as const));
  let cursor = 0;
  for (const leaf of lhsLeaves) {
    const partner = rhsIndex.get(leaf.alignment_id);
    if (partner === undefined) {
      oneSided(leaf, 0);
      continue;
    }
    while (cursor < partner) oneSided(rhsLeaves[cursor++], 1);
    const a = regionLines(leaf);
    const b = regionLines(rhsLeaves[partner]);
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

/** Tags are `<plugin>:<name>`; several plugins capture docstrings, each under its own prefix. */
const isDocstring = (region: StructuralRegion) => region.tags?.some((tag) => tag.slice(tag.lastIndexOf(":") + 1) === "docstring") === true;

/** A hidden band on one or both sides, one-based like Monaco's diff editor. */
export interface StructuralGap {
  originalStart: number;
  modifiedStart: number;
  originalCount: number;
  modifiedCount: number;
  label: string;
  /** What the band hides: unchanged context, or lines that exist on one side only. */
  owner: "base" | "head" | "both";
  change: "unchanged" | "inserted" | "removed" | "modified";
  /** False for a region the reader revealed: it stays a band the editor can fold again. */
  collapsed: boolean;
  /** The fold-state id of the region(s) this band hides; toggling the band toggles it. */
  foldStateId: number;
  /** False for a bundled docstring: its band shows the bare count, no symbol names. */
  breadcrumbs: boolean;
}

/**
 * The text a band shows under its title. diffr prepends a `<comment> pseudocode`
 * line to a summary for terminals; the app has its own caption, so that line
 * is dropped here. A one-line label has no detail.
 */
export function bandDetail(label: string): string {
  const lines = label.split("\n");
  if (lines.length < 2) return "";
  const body = /^(\/\/|#|--|;|%)\s*pseudocode$/.test(lines[0].trim()) ? lines.slice(1) : lines;
  return body.join("\n");
}

/**
 * The lines a collapsed region hides on its side, zero-based half-open: every
 * line it covers, fold or leaf. A fold covers its body alone — the line that
 * opens the construct is the last line of the leaf before it — so a band
 * hides exactly the fold's range, and the signature above it stays a row.
 */
export function hiddenLinesOf(region: StructuralRegion): { start: number; end: number } {
  return regionLines(region);
}

/** Collapsed regions of one side, outermost first; a collapsed descendant of a collapsed region is subsumed. `isCollapsed` answers for a fold-state id. */
export function collapsedRegions(
  regions: readonly StructuralRegion[] | undefined,
  isCollapsed: (foldStateId: number) => boolean,
): StructuralRegion[] {
  return knownRegions(regions, (id) => (isCollapsed(id) ? true : undefined)).map((r) => r.region);
}

/**
 * Regions of one side the state knows about, outermost first: collapsed ones
 * and ones a reader revealed. A collapsed region subsumes its descendants; a
 * revealed one still lists them, since a child may be collapsed on its own.
 */
export function knownRegions(
  regions: readonly StructuralRegion[] | undefined,
  state: (foldStateId: number) => boolean | undefined,
): { region: StructuralRegion; collapsed: boolean }[] {
  const result: { region: StructuralRegion; collapsed: boolean }[] = [];
  const walk = (region: StructuralRegion) => {
    const known = state(region.fold_state_id);
    const hides = hiddenLinesOf(region).end > hiddenLinesOf(region).start;
    if (known === true) {
      if (hides) result.push({ region, collapsed: true });
      return;
    }
    // Open, but a band by the wire's default: a reader revealed it, and the editor can fold it again.
    if (known === false && hides && region.visibility?.collapsed === true) result.push({ region, collapsed: false });
    if (region.kind === "fold") for (const child of region.children) walk(child);
  };
  for (const region of regions ?? []) walk(region);
  return result;
}

/**
 * Every collapsed region as a diff-editor band. A region collapsed on both
 * sides becomes one band: a leaf with the leaf sharing its `alignment_id`, a
 * fold with the fold sharing its `fold_state_id` (a docstring only with a
 * docstring, since a docstring shares its body's fold state). A region on one side only
 * becomes a band on that side; the other side's range starts right after the
 * row that precedes the region and covers only the opposite lines the zip put
 * inside the region's rows, none when those rows are filler.
 */
export function structuralContextGaps(
  diff: StructuralTextDiff,
  isCollapsed: (foldStateId: number) => boolean,
  state: (foldStateId: number) => boolean | undefined = (id) => (isCollapsed(id) ? true : undefined),
): StructuralGap[] {
  const rows = structuralRows(diff);
  const rowOfLeft = new Map<number, number>(), rowOfRight = new Map<number, number>();
  rows.forEach(([l, r], index) => {
    if (l !== null) rowOfLeft.set(l, index);
    if (r !== null) rowOfRight.set(r, index);
  });
  // One-based start and count of the opposite range for lines hidden on `side`. Rows are monotone, so
  // the opposite lines inside the region's rows follow the opposite line of the row before it.
  const oppositeSpan = (side: 0 | 1, hidden: { start: number; end: number }): { start: number; count: number } => {
    const other = side === 0 ? 1 : 0;
    const rowOf = side === 0 ? rowOfLeft : rowOfRight;
    const first = rowOf.get(hidden.start)!, last = rowOf.get(hidden.end - 1)!;
    let before = -1;
    for (let index = first - 1; index >= 0 && before === -1; index--) before = rows[index][other] ?? -1;
    let count = 0;
    for (let index = first; index <= last; index++) if (rows[index][other] !== null) count++;
    return { start: before + 2, count };
  };
  const lhs = knownRegions(diff.lhs?.regions, state);
  const rhs = knownRegions(diff.rhs?.regions, state);
  // Leaves pair by alignment; folds pair by fold state, the only identity they share across sides.
  const usedRhs = new Set<StructuralRegion>();
  const pairs = (left: StructuralRegion, right: StructuralRegion) => {
    if (left.kind === "leaf") return right.kind === "leaf" && right.alignment_id === left.alignment_id;
    return right.kind === "fold" && right.fold_state_id === left.fold_state_id && isDocstring(right) === isDocstring(left);
  };
  const counterpart = (left: StructuralRegion) =>
    rhs.find(({ region: right }) => !usedRhs.has(right) && pairs(left, right));
  const gaps: StructuralGap[] = [];
  for (const { region: left, collapsed } of lhs) {
    const hidden = hiddenLinesOf(left);
    const partner = counterpart(left);
    if (partner) {
      usedRhs.add(partner.region);
      const right = hiddenLinesOf(partner.region);
      gaps.push({
        originalStart: hidden.start + 1, originalCount: hidden.end - hidden.start,
        modifiedStart: right.start + 1, modifiedCount: right.end - right.start,
        label: partner.region.visibility?.label || left.visibility?.label || "",
        owner: "both", change: "unchanged",
        collapsed: collapsed && partner.collapsed,
        foldStateId: left.fold_state_id,
        breadcrumbs: !isDocstring(left) && !isDocstring(partner.region),
      });
      continue;
    }
    const opposite = oppositeSpan(0, hidden);
    gaps.push({
      originalStart: hidden.start + 1, originalCount: hidden.end - hidden.start,
      modifiedStart: opposite.start, modifiedCount: opposite.count,
      label: left.visibility?.label || "", owner: "base", change: "unchanged", collapsed, foldStateId: left.fold_state_id,
      breadcrumbs: !isDocstring(left),
    });
  }
  for (const { region: right, collapsed } of rhs) {
    if (usedRhs.has(right)) continue;
    const hidden = hiddenLinesOf(right);
    const opposite = oppositeSpan(1, hidden);
    gaps.push({
      originalStart: opposite.start, originalCount: opposite.count,
      modifiedStart: hidden.start + 1, modifiedCount: hidden.end - hidden.start,
      label: right.visibility?.label || "", owner: "head", change: "unchanged", collapsed, foldStateId: right.fold_state_id,
      breadcrumbs: !isDocstring(right),
    });
  }
  // Ownership says which fold state to toggle, never whether its contents were deleted.
  const highlights = structuralHighlights(diff);
  const removedLines = new Set(highlights.originalLines), addedLines = new Set(highlights.modifiedLines);
  for (const [left, right] of rows) {
    if (left !== null && right === null) removedLines.add(left + 1);
    if (right !== null && left === null) addedLines.add(right + 1);
  }
  for (const gap of gaps) {
    const removed = [...removedLines].some(line => line >= gap.originalStart && line < gap.originalStart + gap.originalCount);
    const added = [...addedLines].some(line => line >= gap.modifiedStart && line < gap.modifiedStart + gap.modifiedCount);
    gap.change = removed && added ? "modified" : removed ? "removed" : added ? "inserted" : "unchanged";
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

/** The file's counts, straight from the wire. Folding never changes them. */
export function structuralInitialCounts(diff: StructuralTextDiff): StructuralFileCounts {
  return { visible: structuralChangeCounts(diff.structural_changes), textual: diff.stats.textual, fallback: diff.stats.fallback };
}

export function structuralCountsTooltip(counts: StructuralFileCounts): string {
  const row = (label: string, value: StructuralLineCounts) => `${label} +${value.added} −${value.removed}`;
  const rows = [row("structural", counts.visible), row("textual", counts.textual)];
  if (counts.fallback) rows.push(`line diff: ${counts.fallback.code}`);
  return rows.join("\n");
}
