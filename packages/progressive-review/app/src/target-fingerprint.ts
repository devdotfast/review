import {
  type GitLabTextDiffRow,
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";

import type { CodePeekResolution } from "../../src/authoring";
import type { ThreadSelection, ThreadTarget } from "../../src/types";
import { parseUnifiedPatch } from "../../src/unified-diff";

export function buildDocumentTextTarget(input: {
  text: string;
  start: number;
  length: number;
}): Extract<ThreadTarget, { kind: "text" }> {
  const text = input.text;
  return {
    kind: "text",
    surface: { type: "document", documentHash: stableHash(text) },
    selection: buildSelection(text, input.start, input.length),
  };
}

export function buildBlockTarget(input: {
  tag: string;
  index: number;
  text: string;
  start: number;
  length: number;
}): Extract<ThreadTarget, { kind: "text" }> {
  const text = input.text;
  return {
    kind: "text",
    surface: {
      type: "block",
      tag: input.tag,
      index: input.index,
      blockHash: stableHash(text),
    },
    selection: buildSelection(text, input.start, input.length),
  };
}

export function buildTableCellTarget(input: {
  table: number;
  row: number;
  column: number;
  text: string;
  start: number;
  length: number;
}): Extract<ThreadTarget, { kind: "text" }> {
  const text = input.text;
  return {
    kind: "text",
    surface: {
      type: "table-cell",
      table: input.table,
      row: input.row,
      column: input.column,
    },
    selection: buildSelection(text, input.start, input.length),
  };
}

export function buildAnchorTextTarget(input: {
  anchorId: string;
  field: "title" | "detail";
  text: string;
  start?: number;
  length?: number;
}): ThreadTarget {
  const text = input.text;
  const start = input.start ?? 0;
  const length = input.length ?? text.length;
  return {
    kind: "text",
    surface: {
      type: "anchor",
      anchorId: input.anchorId,
      part: { type: "text", field: input.field },
    },
    selection: buildSelection(text, start, length),
  };
}

export function buildCodeTarget(input: {
  path: string;
  side: "base" | "head";
  baseCommit: string;
  headCommit: string;
  span: { startLine: number; endLine: number };
}): Extract<ThreadTarget, { kind: "code" }> {
  if (!input.path) throw new Error("Code target path must not be empty.");
  if (!input.baseCommit || !input.headCommit) {
    throw new Error("Code target commits must not be empty.");
  }
  if (
    !Number.isInteger(input.span.startLine) ||
    !Number.isInteger(input.span.endLine) ||
    input.span.startLine < 1 ||
    input.span.endLine < input.span.startLine
  ) {
    throw new Error("Code target must contain a valid inclusive line span.");
  }
  const row = (line: number) => ({
    old_line: input.side === "base" ? line : null,
    new_line: input.side === "head" ? line : null,
  });
  const position = createGitLabTextDiffPosition({
    base_sha: input.baseCommit,
    start_sha: input.baseCommit,
    head_sha: input.headCommit,
    old_path: input.path,
    new_path: input.path,
    start: row(input.span.startLine),
    end: row(input.span.endLine),
  });
  return { kind: "code", original_position: position, position };
}

export function codeTargetResource(
  target: Extract<ThreadTarget, { kind: "code" }>,
  side: "base" | "head",
): { path: string; commit: string } | null {
  const rows = gitLabDiffPositionRows(target.position);
  if (!rows || !positionUsesSide(rows.start, rows.end, side)) return null;
  const path =
    side === "base" ? target.position.old_path : target.position.new_path;
  const commit =
    side === "base"
      ? (target.position.base_sha ?? target.position.start_sha)
      : target.position.head_sha;
  return path && commit ? { path, commit } : null;
}

export function codeTargetProjectionSides(
  target: Extract<ThreadTarget, { kind: "code" }>,
  defaultSide: "base" | "head" = "head",
): Array<"base" | "head"> {
  const rows = gitLabDiffPositionRows(target.position);
  if (!rows) return [];
  const endpoints = [rows.start, rows.end];
  const hasOldOnly = endpoints.some(
    (row) => row.old_line !== null && row.new_line === null,
  );
  const hasNewOnly = endpoints.some(
    (row) => row.old_line === null && row.new_line !== null,
  );
  if (hasOldOnly && hasNewOnly) return ["base", "head"];
  if (hasOldOnly) return ["base"];
  if (hasNewOnly) return ["head"];
  return codeTargetResource(target, defaultSide) ? [defaultSide] : [];
}

export function projectCodeTarget(
  target: Extract<ThreadTarget, { kind: "code" }>,
  side: "base" | "head",
  patch?: string,
): {
  path: string;
  commit: string;
  span: { startLine: number; endLine: number };
} | null {
  const resource = codeTargetResource(target, side);
  const rows = gitLabDiffPositionRows(target.position);
  if (!resource || !rows) return null;
  const startLine = lineForSide(rows.start, side);
  const endLine = lineForSide(rows.end, side);
  if (startLine !== null && endLine !== null) {
    return {
      ...resource,
      span: {
        startLine: Math.min(startLine, endLine),
        endLine: Math.max(startLine, endLine),
      },
    };
  }
  if (!patch) return null;
  const span = projectPositionRowsThroughPatch(
    resource.path,
    patch,
    rows.start,
    rows.end,
    side,
  );
  return span ? { ...resource, span } : null;
}

export function buildGraphTarget(input: {
  diagram: string;
  type: "node" | "edge";
  path: string[];
  payload: unknown;
  quote: string;
}): Extract<ThreadTarget, { kind: "graph" }> {
  return {
    kind: "graph",
    diagram: input.diagram,
    element: {
      type: input.type,
      path: input.path,
      hash: stableHash(fingerprintPayload(input.payload)),
      quote: input.quote,
    },
  };
}

export function buildSelection(
  surfaceText: string,
  start: number,
  length: number,
): ThreadSelection {
  if (!Number.isInteger(start) || start < 0) {
    throw new Error("Selection start must be a non-negative integer.");
  }
  if (!Number.isInteger(length) || length < 1) {
    throw new Error("Selection length must be a positive integer.");
  }
  const quote = surfaceText.slice(start, start + length);
  if (quote.length !== length) {
    throw new Error("Selection must be contained in the target surface.");
  }
  return { start, length, hash: stableHash(quote), quote };
}

export interface ResolvedCodeSurface {
  text: string;
  file: string;
  fromLine: number;
}

export function resolvedCodeSurface(
  resolution: CodePeekResolution,
): ResolvedCodeSurface {
  const root = resolution.snapshot.roots[0];
  const resolved = root
    ? resolution.snapshot.resolved[root.sourceId]
    : undefined;
  if (!resolved) {
    throw new Error("CodePeek resolution contains no resolved root source.");
  }
  return {
    text: normalizeLineEndings(
      resolved.lines
        .map((line) => line.map((token) => token.t).join(""))
        .join("\n"),
    ),
    file: resolved.source.file,
    fromLine: resolved.source.line,
  };
}

export function targetKey(target: ThreadTarget): string {
  return `review-${stableHash(targetIdentityKey(target))}`;
}

export function targetIdentityKey(target: ThreadTarget): string {
  return stableSerialize(target);
}

export function targetsEqual(left: ThreadTarget, right: ThreadTarget): boolean {
  return targetIdentityKey(left) === targetIdentityKey(right);
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintPayload(value: unknown): string {
  return typeof value === "string" ? value : stableSerialize(value);
}

function positionUsesSide(
  start: GitLabTextDiffRow,
  end: GitLabTextDiffRow,
  side: "base" | "head",
): boolean {
  return lineForSide(start, side) !== null || lineForSide(end, side) !== null;
}

function lineForSide(
  row: GitLabTextDiffRow,
  side: "base" | "head",
): number | null {
  return side === "base" ? row.old_line : row.new_line;
}

function projectPositionRowsThroughPatch(
  path: string,
  patch: string,
  start: GitLabTextDiffRow,
  end: GitLabTextDiffRow,
  side: "base" | "head",
): { startLine: number; endLine: number } | null {
  for (const hunk of parseUnifiedPatch(path, patch)) {
    const startIndex = hunk.lines.findIndex((line) =>
      diffLineMatchesPosition(line, start),
    );
    const endIndex = hunk.lines.findIndex((line) =>
      diffLineMatchesPosition(line, end),
    );
    if (startIndex < 0 || endIndex < 0) continue;
    const first = Math.min(startIndex, endIndex);
    const last = Math.max(startIndex, endIndex);
    const lines = hunk.lines
      .slice(first, last + 1)
      .map((line) => (side === "base" ? line.oldLine : line.newLine))
      .filter((line): line is number => line !== null);
    if (lines.length === 0) return null;
    return {
      startLine: Math.min(...lines),
      endLine: Math.max(...lines),
    };
  }
  return null;
}

function diffLineMatchesPosition(
  line: { oldLine: number | null; newLine: number | null },
  row: GitLabTextDiffRow,
): boolean {
  return line.oldLine === row.old_line && line.newLine === row.new_line;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Target fingerprint payload is not serializable.");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const fields: [string, unknown][] = Object.entries(value);
  return `{${fields
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, field]) => `${JSON.stringify(key)}:${stableSerialize(field)}`)
    .join(",")}}`;
}
