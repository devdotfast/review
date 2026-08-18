import {
  type LocalVcsDiffFileSummary,
  diffFileSummariesTrees,
  diffTrees,
} from "@dev.fast/local-vcs";
import {
  type GitLabDiffPosition,
  type GitLabTextDiffRow,
  createGitLabTextDiffPosition,
} from "@dev.fast/review-protocol";

import { type DiffHunk, parseUnifiedPatch } from "./unified-diff";

interface LegacyCodeSpan {
  startLine: number;
  endLine: number;
}

interface LegacyCodeTarget {
  kind: "code";
  path: string;
  side: "base" | "head";
  commit: string;
  span: LegacyCodeSpan;
}

interface LegacyCodeChangePosition {
  fromCommit: string;
  toCommit: string;
  oldPath: string;
  newPath: string | null;
  oldSpan: LegacyCodeSpan;
  newSpan: LegacyCodeSpan | null;
}

interface ReviewCodeMigrationContext {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}

interface DiffPair {
  baseCommit: string;
  headCommit: string;
}

interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

export type LegacyCodeRecordKind = "comment" | "comment-draft";

export function createLegacyCodeRecordMigrator(
  context: ReviewCodeMigrationContext,
): (record: unknown, kind: LegacyCodeRecordKind) => Promise<unknown> {
  const fileDiffs = new Map<string, Promise<FileDiff>>();

  const migrateThread = async (value: unknown): Promise<unknown> => {
    const thread = objectRecord(value, "legacy code comment thread");
    if (!isLegacyCodeTarget(thread.target)) return value;
    const target = parseLegacyCodeTarget(thread.target);
    const original = parseLegacyCodeTarget(
      thread.originalTarget ?? thread.target,
    );
    const change = parseLegacyChangePosition(thread.changePosition);
    const originalPosition = await positionForTarget(original);
    const position = await positionForTarget(target);
    const nextTarget = {
      kind: "code",
      original_position: originalPosition,
      position,
      ...(change?.newSpan === null
        ? {
            change_position: {
              ...position,
              base_sha: context.baseCommit,
              start_sha: context.baseCommit,
              head_sha: context.headCommit,
            },
          }
        : {}),
    };
    const {
      originalTarget: _originalTarget,
      changePosition: _changePosition,
      ...rest
    } = thread;
    return { ...rest, target: nextTarget };
  };

  const positionForTarget = async (
    target: LegacyCodeTarget,
  ): Promise<GitLabDiffPosition> => {
    const pair = diffPairForTarget(target, context);
    const cacheKey = `${pair.baseCommit}\0${pair.headCommit}\0${target.side}\0${target.path}`;
    let fileDiff = fileDiffs.get(cacheKey);
    if (!fileDiff) {
      fileDiff = loadFileDiff(context.rootPath, pair, target);
      fileDiffs.set(cacheKey, fileDiff);
    }
    const resolved = await fileDiff;
    return createGitLabTextDiffPosition({
      base_sha: pair.baseCommit,
      start_sha: pair.baseCommit,
      head_sha: pair.headCommit,
      old_path: resolved.oldPath,
      new_path: resolved.newPath,
      start: diffRowForLine(resolved.hunks, target.side, target.span.startLine),
      end: diffRowForLine(resolved.hunks, target.side, target.span.endLine),
    });
  };

  return async (record, kind) => {
    if (kind === "comment") return migrateThread(record);
    const draft = objectRecord(record, "legacy code comment draft");
    const thread = await migrateThread(draft.thread);
    if (thread === draft.thread) return record;
    const migratedThread = objectRecord(thread, "migrated code comment thread");
    const inputs = Array.isArray(draft.inputs)
      ? draft.inputs.map((input) => {
          if (!isObject(input) || !isLegacyCodeTarget(input.target))
            return input;
          return { ...input, target: migratedThread.target };
        })
      : draft.inputs;
    return { ...draft, thread, inputs };
  };
}

function diffPairForTarget(
  target: LegacyCodeTarget,
  context: ReviewCodeMigrationContext,
): DiffPair {
  return target.side === "head"
    ? { baseCommit: context.baseCommit, headCommit: target.commit }
    : { baseCommit: target.commit, headCommit: context.headCommit };
}

async function loadFileDiff(
  rootPath: string,
  pair: DiffPair,
  target: LegacyCodeTarget,
): Promise<FileDiff> {
  const summaries = await diffFileSummariesTrees({
    rootPath,
    baseRef: pair.baseCommit,
    headRef: pair.headCommit,
    paths: [target.path],
  });
  const summary = summaries.find((candidate) =>
    summaryMatchesTarget(candidate, target),
  );
  const oldPath = summaryOldPath(summary, target.path);
  const newPath = summaryNewPath(summary, target.path);
  if (target.side === "base" && !oldPath) {
    throw new Error(`Legacy code target ${target.path} has no base file.`);
  }
  if (target.side === "head" && !newPath) {
    throw new Error(`Legacy code target ${target.path} has no head file.`);
  }
  const paths = [...new Set([oldPath, newPath].filter(isString))];
  const patch = summary
    ? await diffTrees({
        rootPath,
        baseRef: pair.baseCommit,
        headRef: pair.headCommit,
        paths,
      })
    : "";
  return {
    oldPath,
    newPath,
    hunks: parseUnifiedPatch(target.path, patch),
  };
}

function summaryMatchesTarget(
  summary: LocalVcsDiffFileSummary,
  target: LegacyCodeTarget,
): boolean {
  return target.side === "base"
    ? (summary.previousPath ?? summary.path) === target.path
    : summary.path === target.path;
}

function summaryOldPath(
  summary: LocalVcsDiffFileSummary | undefined,
  fallback: string,
): string | null {
  if (summary?.status === "added") return null;
  return summary?.previousPath ?? summary?.path ?? fallback;
}

function summaryNewPath(
  summary: LocalVcsDiffFileSummary | undefined,
  fallback: string,
): string | null {
  return summary?.status === "deleted" ? null : (summary?.path ?? fallback);
}

function diffRowForLine(
  hunks: DiffHunk[],
  side: "base" | "head",
  line: number,
): GitLabTextDiffRow {
  let oldCursor = 1;
  let newCursor = 1;
  for (const hunk of hunks) {
    const sideStart = side === "base" ? hunk.oldStart : hunk.newStart;
    const sideLength = side === "base" ? hunk.oldLines : hunk.newLines;
    if (line < sideStart) {
      return side === "base"
        ? { old_line: line, new_line: newCursor + line - oldCursor }
        : { old_line: oldCursor + line - newCursor, new_line: line };
    }
    if (line < sideStart + sideLength) {
      const match = hunk.lines.find((candidate) =>
        side === "base"
          ? candidate.oldLine === line
          : candidate.newLine === line,
      );
      if (!match) {
        throw new Error(`Could not locate ${side} line ${line} in its diff.`);
      }
      return { old_line: match.oldLine, new_line: match.newLine };
    }
    oldCursor = hunk.oldStart + hunk.oldLines;
    newCursor = hunk.newStart + hunk.newLines;
  }
  return side === "base"
    ? { old_line: line, new_line: newCursor + line - oldCursor }
    : { old_line: oldCursor + line - newCursor, new_line: line };
}

function parseLegacyCodeTarget(value: unknown): LegacyCodeTarget {
  if (!isLegacyCodeTarget(value)) {
    throw new Error("Legacy code target is malformed.");
  }
  const span = objectRecord(value.span, "legacy code target span");
  if (
    typeof value.path !== "string" ||
    (value.side !== "base" && value.side !== "head") ||
    typeof value.commit !== "string" ||
    !positiveInteger(span.startLine) ||
    !positiveInteger(span.endLine) ||
    span.endLine < span.startLine
  ) {
    throw new Error("Legacy code target is malformed.");
  }
  return {
    kind: "code",
    path: value.path,
    side: value.side,
    commit: value.commit,
    span: { startLine: span.startLine, endLine: span.endLine },
  };
}

function parseLegacyChangePosition(
  value: unknown,
): LegacyCodeChangePosition | null {
  if (value === undefined) return null;
  const change = objectRecord(value, "legacy code change position");
  const oldSpan = parseLegacySpan(change.oldSpan);
  const newSpan =
    change.newSpan === null ? null : parseLegacySpan(change.newSpan);
  if (
    typeof change.fromCommit !== "string" ||
    typeof change.toCommit !== "string" ||
    typeof change.oldPath !== "string" ||
    (change.newPath !== null && typeof change.newPath !== "string")
  ) {
    throw new Error("Legacy code change position is malformed.");
  }
  return {
    fromCommit: change.fromCommit,
    toCommit: change.toCommit,
    oldPath: change.oldPath,
    newPath: change.newPath,
    oldSpan,
    newSpan,
  };
}

function parseLegacySpan(value: unknown): LegacyCodeSpan {
  const span = objectRecord(value, "legacy code span");
  if (
    !positiveInteger(span.startLine) ||
    !positiveInteger(span.endLine) ||
    span.endLine < span.startLine
  ) {
    throw new Error("Legacy code span is malformed.");
  }
  return { startLine: span.startLine, endLine: span.endLine };
}

function isLegacyCodeTarget(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.kind === "code" && "path" in value;
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${name} is malformed.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isString(value: string | null): value is string {
  return value !== null;
}
