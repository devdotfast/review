import {
  type LocalVcsDiffFileSummary,
  diffFileSummariesTrees,
  diffTrees,
} from "@dev.fast/local-vcs";
import {
  type GitLabDiffPosition,
  type GitLabTextDiffRow,
  type JsonObject,
  type JsonValue,
  createGitLabTextDiffPosition,
  isJsonObject,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { type DiffHunk, parseUnifiedPatch } from "./unified-diff";

const LegacyCodeSpanSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((span) => span.endLine >= span.startLine);

type LegacyCodeSpan = z.infer<typeof LegacyCodeSpanSchema>;

const LegacyCodeTargetSchema = z.object({
  kind: z.literal("code"),
  path: z.string(),
  side: z.enum(["base", "head"]),
  commit: z.string(),
  span: LegacyCodeSpanSchema,
});

type LegacyCodeTarget = z.infer<typeof LegacyCodeTargetSchema>;

const LegacyCodeChangePositionSchema = z.object({
  fromCommit: z.string(),
  toCommit: z.string(),
  oldPath: z.string(),
  newPath: z.string().nullable(),
  oldSpan: LegacyCodeSpanSchema,
  newSpan: LegacyCodeSpanSchema.nullable(),
});

type LegacyCodeChangePosition = z.infer<typeof LegacyCodeChangePositionSchema>;

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
): (record: JsonValue, kind: LegacyCodeRecordKind) => Promise<JsonValue> {
  const fileDiffs = new Map<string, Promise<FileDiff>>();

  const migrateThread = async (value: JsonValue): Promise<JsonValue> => {
    const thread = objectRecord(value, "legacy code comment thread");
    if (!isLegacyCodeTarget(thread.target)) return value;
    const target = parseLegacyCodeTarget(thread.target);
    const original = parseLegacyCodeTarget(
      thread.originalTarget ?? thread.target,
    );
    const change = parseLegacyChangePosition(thread.changePosition);
    const originalPosition = await positionForTarget(original);
    const position = await positionForTarget(target);
    const nextTarget: JsonObject = {
      kind: "code",
      original_position: storedDiffPosition(originalPosition),
      position: storedDiffPosition(position),
      ...(change?.newSpan === null
        ? {
            change_position: storedDiffPosition({
              ...position,
              base_sha: context.baseCommit,
              start_sha: context.baseCommit,
              head_sha: context.headCommit,
            }),
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
          if (!isJsonObject(input) || !isLegacyCodeTarget(input.target))
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

function parseLegacyCodeTarget(value: JsonValue): LegacyCodeTarget {
  const parsed = LegacyCodeTargetSchema.safeParse(value);
  if (!parsed.success) throw new Error("Legacy code target is malformed.");
  return parsed.data;
}

function parseLegacyChangePosition(
  value: JsonValue | undefined,
): LegacyCodeChangePosition | null {
  if (value === undefined) return null;
  const parsed = LegacyCodeChangePositionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Legacy code change position is malformed.");
  }
  return parsed.data;
}

/** A diff position as review.db stores it: serialized, undefined optionals dropped. */
function storedDiffPosition(position: GitLabDiffPosition): JsonObject {
  const stored = jsonObject(parseJsonText(JSON.stringify(position)));
  if (!stored) throw new Error("Diff position did not serialize to an object.");
  return stored;
}

function isLegacyCodeTarget(value: JsonValue | undefined): value is JsonObject {
  return isJsonObject(value) && value.kind === "code" && "path" in value;
}

function objectRecord(value: JsonValue | undefined, name: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${name} is malformed.`);
  return value;
}

function isString(value: string | null): value is string {
  return value !== null;
}
