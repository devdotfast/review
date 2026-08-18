import { gitLabDiffPositionPath } from "@dev.fast/review-protocol";

import type { ThreadTarget } from "../../src/types";
import { stableHash } from "./target-fingerprint";

export interface LiveTextBlock {
  tag: string;
  index: number;
  text: string;
}

export interface LiveTableCell {
  table: number;
  row: number;
  column: number;
  text: string;
}

export interface LiveAnchorTarget {
  anchorId: string;
  title: string;
  detail?: string;
  content?: { text: string };
}

export interface LiveDiagramTarget {
  label: string;
  elements: Extract<ThreadTarget, { kind: "graph" }>[];
}

export interface LiveThreadTargetModel {
  documentText: string | null;
  blocks: readonly LiveTextBlock[];
  tableCells: readonly LiveTableCell[];
  anchors: ReadonlyMap<string, LiveAnchorTarget>;
  diagrams: ReadonlyMap<string, LiveDiagramTarget>;
}

export type ThreadTargetState =
  | { state: "attached"; target: ThreadTarget }
  | { state: "outdated"; reason: "edited" | "gone" };

export function resolveTargetState(
  thread: { target: ThreadTarget },
  live: LiveThreadTargetModel,
): ThreadTargetState {
  const target = thread.target;
  if (target.kind === "document") return { state: "attached", target };
  if (target.kind === "code") {
    if (target.change_position) {
      return {
        state: "outdated",
        reason: gitLabDiffPositionPath(target.change_position)
          ? "edited"
          : "gone",
      };
    }
    return { state: "attached", target };
  }
  if (target.kind === "graph") return resolveGraphTarget(target, live);
  if (target.surface.type === "document") {
    return resolveDocumentTextTarget(target, live.documentText);
  }
  if (target.surface.type === "block") {
    return resolveBlockTarget(target, live.blocks);
  }
  if (target.surface.type === "table-cell") {
    const surface = target.surface;
    const cell = live.tableCells.find(
      (candidate) =>
        candidate.table === surface.table &&
        candidate.row === surface.row &&
        candidate.column === surface.column,
    );
    if (!cell) return { state: "outdated", reason: "gone" };
    return selectionMatches(cell.text, target)
      ? { state: "attached", target }
      : { state: "outdated", reason: "edited" };
  }
  const anchor = live.anchors.get(target.surface.anchorId);
  if (!anchor) return { state: "outdated", reason: "gone" };
  const text =
    target.surface.part.field === "title" ? anchor.title : anchor.detail;
  if (text === undefined) return { state: "outdated", reason: "gone" };
  return selectionMatches(text, target)
    ? { state: "attached", target }
    : { state: "outdated", reason: "edited" };
}

function resolveDocumentTextTarget(
  target: Extract<ThreadTarget, { kind: "text" }>,
  documentText: string | null,
): ThreadTargetState {
  if (target.surface.type !== "document") {
    throw new Error("resolveDocumentTextTarget requires a document surface.");
  }
  if (documentText === null) return { state: "outdated", reason: "gone" };
  const text = documentText;
  const documentHash = stableHash(text);
  let start = target.selection.start;
  if (
    target.surface.documentHash !== documentHash ||
    !selectionHashMatches(
      text,
      start,
      target.selection.length,
      target.selection.hash,
    )
  ) {
    const occurrences = quoteOccurrences(text, target.selection.quote);
    if (occurrences.length !== 1) {
      return { state: "outdated", reason: "edited" };
    }
    start = occurrences[0]!;
  }
  return {
    state: "attached",
    target: {
      ...target,
      surface: { ...target.surface, documentHash },
      selection: { ...target.selection, start },
    },
  };
}

function resolveBlockTarget(
  target: Extract<ThreadTarget, { kind: "text" }>,
  blocks: readonly LiveTextBlock[],
): ThreadTargetState {
  if (target.surface.type !== "block") {
    throw new Error("resolveBlockTarget requires a block target.");
  }
  const surface = target.surface;
  const candidates = blocks.filter((block) => block.tag === surface.tag);
  const hashMatches = candidates.filter(
    (block) => stableHash(block.text) === surface.blockHash,
  );
  if (hashMatches.length > 1) {
    return { state: "outdated", reason: "edited" };
  }
  if (hashMatches.length === 0) {
    const indexedBlock = candidates.find(
      (candidate) => candidate.index === surface.index,
    );
    return {
      state: "outdated",
      reason: indexedBlock ? "edited" : "gone",
    };
  }

  const block = hashMatches[0]!;
  const text = block.text;
  if (
    !selectionHashMatches(
      text,
      target.selection.start,
      target.selection.length,
      target.selection.hash,
    )
  ) {
    return { state: "outdated", reason: "edited" };
  }

  return {
    state: "attached",
    target: {
      ...target,
      surface: {
        ...target.surface,
        index: block.index,
      },
    },
  };
}

function resolveGraphTarget(
  target: Extract<ThreadTarget, { kind: "graph" }>,
  live: LiveThreadTargetModel,
): ThreadTargetState {
  const diagram = live.diagrams.get(target.diagram);
  if (!diagram) return { state: "outdated", reason: "gone" };
  const element = diagram.elements.find(
    (candidate) =>
      candidate.element.type === target.element.type &&
      pathsEqual(candidate.element.path, target.element.path),
  );
  if (!element) return { state: "outdated", reason: "gone" };
  return element.element.hash === target.element.hash
    ? { state: "attached", target }
    : { state: "outdated", reason: "edited" };
}

function selectionMatches(
  text: string,
  target: Extract<ThreadTarget, { kind: "text" }>,
): boolean {
  return selectionHashMatches(
    text,
    target.selection.start,
    target.selection.length,
    target.selection.hash,
  );
}

function quoteOccurrences(text: string, quote: string): number[] {
  const offsets: number[] = [];
  let offset = text.indexOf(quote);
  while (offset >= 0) {
    offsets.push(offset);
    offset = text.indexOf(quote, offset + 1);
  }
  return offsets;
}

function selectionHashMatches(
  text: string,
  start: number,
  length: number,
  hash: string,
): boolean {
  const selection = text.slice(start, start + length);
  return selection.length === length && stableHash(selection) === hash;
}

function pathsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}
