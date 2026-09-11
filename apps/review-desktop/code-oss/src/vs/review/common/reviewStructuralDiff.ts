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
 * Native folding keeps its start line visible and hides the lines after it,
 * and Monaco only accepts ranges that nest: a range may sit inside another
 * or after it, never straddle one, and no two may start on the same line.
 *
 * A fold's header is its own first line (the signature). A collapsed leaf has
 * no header of its own, so `structuralFoldRanges` picks one: the line above
 * the leaf when that line is free, so the fold hides exactly the leaf's
 * lines; otherwise the first line of the leaf that is free, so the fold hides
 * the rest. A line is free when it is not a fold's header, not hidden by
 * another collapsed leaf, and not inside a fold that is not one of the leaf's
 * ancestors.
 */
export function nativeFoldRange(
  region: StructuralRegion,
  headerLine?: number,
): { start: number; end: number } | undefined {
  const lines = regionLines(region);
  const header = headerLine ?? lines.start;
  const start = header + 1;
  return lines.end > start ? { start, end: lines.end } : undefined;
}

/** Every folding region of one side with its native range, in order, nesting guaranteed. */
export function structuralFoldRanges(
  regions: readonly StructuralRegion[] | undefined,
): { region: StructuralRegion; range: { start: number; end: number } }[] {
  const foldable = new Set(structuralFoldingRegions(regions));
  const foldHeaderLines = new Set<number>();
  /** The innermost fold covering each line. */
  const lineOwner = new Map<number, StructuralRegion>();
  const walkOwners = (region: StructuralRegion) => {
    if (region.kind !== "fold") return;
    const lines = regionLines(region);
    foldHeaderLines.add(lines.start);
    for (let line = lines.start; line < lines.end; line++) lineOwner.set(line, region);
    for (const child of region.children) walkOwners(child);
  };
  for (const region of regions ?? []) walkOwners(region);
  const hiddenLines = new Set<number>();
  for (const region of foldable) {
    if (region.kind !== "leaf") continue;
    const lines = regionLines(region);
    for (let line = lines.start; line < lines.end; line++) hiddenLines.add(line);
  }
  const result: { region: StructuralRegion; range: { start: number; end: number } }[] = [];
  // Monaco keeps one range per start line. A fold that begins on its parent's
  // first line (a group wrapping the bodies it names) yields to the parent,
  // whose collapse hides it anyway; regions are visited outermost first.
  const starts = new Set<number>();
  const walk = (
    region: StructuralRegion,
    ancestors: readonly StructuralRegion[],
    enclosing: { start: number; end: number } | undefined,
  ) => {
    let emitted = enclosing;
    if (foldable.has(region)) {
      let range: { start: number; end: number } | undefined;
      if (region.kind === "fold") range = nativeFoldRange(region);
      else {
        const lines = regionLines(region);
        const parent = ancestors[ancestors.length - 1];
        const free = (line: number) => {
          if (line < 0 || foldHeaderLines.has(line)) return false;
          // The header must sit inside the parent fold, below the parent's own header line.
          if (parent && line <= regionLines(parent).start) return false;
          if (line < lines.start && hiddenLines.has(line)) return false;
          const owner = lineOwner.get(line);
          return owner === undefined || ancestors.includes(owner);
        };
        for (let header = lines.start - 1; header < lines.end - 1; header++) {
          if (!free(header)) continue;
          range = nativeFoldRange(region, header);
          break;
        }
      }
      // A child whose range runs past its parent's would make Monaco drop folding for
      // the whole file, so it is clamped to the parent; an emptied child is dropped.
      if (range && enclosing && range.end > enclosing.end) range = { start: range.start, end: enclosing.end };
      if (range && range.end > range.start && !starts.has(range.start)) {
        starts.add(range.start);
        result.push({ region, range });
        emitted = range;
      }
    }
    if (region.kind === "fold") for (const child of region.children) walk(child, [...ancestors, region], emitted);
  };
  for (const region of regions ?? []) walk(region, [], undefined);
  return result;
}

/**
 * Throws unless the ranges nest the way Monaco's folding model requires.
 * Used by tests and by the reader in development to catch a bad projection
 * before it silently disables folding for a whole file.
 */
export function assertFoldRangesNest(ranges: readonly { start: number; end: number }[]): void {
  const open: { start: number; end: number }[] = [];
  let previousStart = -1;
  for (const range of ranges) {
    if (range.start >= range.end) throw new Error(`fold range ${range.start}..${range.end} is empty`);
    if (range.start === previousStart) throw new Error(`two fold ranges start on line ${range.start}`);
    if (range.start < previousStart) throw new Error(`fold ranges are out of order at line ${range.start}`);
    previousStart = range.start;
    while (open.length && range.start > open[open.length - 1].end) open.pop();
    const parent = open[open.length - 1];
    if (parent && range.end > parent.end) {
      throw new Error(`fold range ${range.start}..${range.end} straddles ${parent.start}..${parent.end}`);
    }
    open.push(range);
  }
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
  for (const { region, range } of structuralFoldRanges(source.regions)) {
    if (!isCollapsed(region.id)) continue;
    // Monaco hides the lines after the fold's start line through its end line.
    for (let line = range.start; line < range.end; line++) changed.delete(line);
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

/**
 * What a collapsed region shows. The header line keeps Monaco's inline `⋯`;
 * a one-line label follows it as injected text, and a multi-line label
 * (pseudocode) hangs under the header as a view zone sized to its lines.
 */
export interface StructuralLabelPlan {
  inline: { line: number; text: string }[];
  zones: { id: number; afterLineNumber: number; heightInLines: number; text: string }[];
}

export function structuralLabelPlan(
  collapsed: readonly { region: StructuralRegion; range: { start: number; end: number } }[],
): StructuralLabelPlan {
  const plan: StructuralLabelPlan = { inline: [], zones: [] };
  for (const { region, range } of collapsed) {
    const label = region.visibility?.label;
    if (!label) continue;
    const lines = label.split("\n");
    if (lines.length === 1) plan.inline.push({ line: range.start, text: ` ${label}` });
    else plan.zones.push({ id: region.id, afterLineNumber: range.start, heightInLines: lines.length, text: label });
  }
  return plan;
}
