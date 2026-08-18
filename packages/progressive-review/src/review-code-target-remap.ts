import {
  type LocalVcsDiffFileSummary,
  diffFileSummariesTrees,
  diffTrees,
} from "@dev.fast/local-vcs";
import {
  type GitLabDiffPosition,
  type GitLabTextDiffRow,
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";

import type {
  ReviewCommentDraftThreadMap,
  ReviewCommentThreadMap,
  ReviewCommentThreadRecord,
} from "./types";
import { type DiffHunk, parseUnifiedPatch } from "./unified-diff";

interface ReviewPins {
  baseCommit: string;
  sourceCommit: string | null;
}

interface CodeSpan {
  startLine: number;
  endLine: number;
}

interface CodeLocation {
  path: string;
  side: "base" | "head";
  commit: string;
  span: CodeSpan;
}

export async function remapReviewCodeThreads(input: {
  rootPath: string;
  comments: ReviewCommentThreadMap;
  from: ReviewPins;
  to: ReviewPins;
}): Promise<ReviewCommentThreadMap> {
  const comments = { ...input.comments };
  const sourceCommit = input.to.sourceCommit;
  if (!sourceCommit) return comments;
  const to = { ...input.to, sourceCommit };

  const transitions = new Map<
    "base" | "head",
    { fromCommit: string; toCommit: string }
  >();
  if (input.from.baseCommit !== input.to.baseCommit) {
    transitions.set("base", {
      fromCommit: input.from.baseCommit,
      toCommit: input.to.baseCommit,
    });
  }
  if (input.from.sourceCommit && input.from.sourceCommit !== sourceCommit) {
    transitions.set("head", {
      fromCommit: input.from.sourceCommit,
      toCommit: sourceCommit,
    });
  }
  if (transitions.size === 0) return comments;

  const summaries = new Map<"base" | "head", LocalVcsDiffFileSummary[]>();
  for (const [side, transition] of transitions) {
    summaries.set(
      side,
      await diffFileSummariesTrees({
        rootPath: input.rootPath,
        baseRef: transition.fromCommit,
        headRef: transition.toCommit,
      }),
    );
  }

  for (const [threadId, thread] of Object.entries(comments)) {
    if (thread.target.kind !== "code") continue;
    comments[threadId] = await remapCodeThread({
      rootPath: input.rootPath,
      thread,
      to,
      transitions,
      summaries,
    });
  }
  return comments;
}

export async function remapReviewCodeDrafts(input: {
  rootPath: string;
  drafts: ReviewCommentDraftThreadMap;
  to: ReviewPins;
}): Promise<ReviewCommentDraftThreadMap> {
  const drafts = { ...input.drafts };
  if (!input.to.sourceCommit) return drafts;

  /* Submission promotes every pending draft and clears the draft store. Drafts
     that reach scaffold --update are questions created after submission while
     the agent is updating the Review. They stay drafts for the next revision. */
  for (const [threadId, draft] of Object.entries(drafts)) {
    if (draft.thread.target.kind !== "code") continue;
    const activePosition =
      draft.thread.target.change_position ?? draft.thread.target.position;
    const baseCommit = activePosition.base_sha ?? activePosition.start_sha;
    const sourceCommit = activePosition.head_sha;
    if (!baseCommit || !sourceCommit) {
      throw new Error(`Code draft ${threadId} has incomplete Git refs.`);
    }
    const remapped = await remapReviewCodeThreads({
      rootPath: input.rootPath,
      comments: { [threadId]: draft.thread },
      from: { baseCommit, sourceCommit },
      to: input.to,
    });
    const thread = remapped[threadId]!;
    drafts[threadId] = {
      thread,
      inputs: draft.inputs.map((comment) => ({
        ...comment,
        target: thread.target,
      })),
    };
  }
  return drafts;
}

async function remapCodeThread(input: {
  rootPath: string;
  thread: ReviewCommentThreadRecord;
  to: ReviewPins & { sourceCommit: string };
  transitions: Map<"base" | "head", { fromCommit: string; toCommit: string }>;
  summaries: Map<"base" | "head", LocalVcsDiffFileSummary[]>;
}): Promise<ReviewCommentThreadRecord> {
  const target = input.thread.target;
  if (target.kind !== "code") return input.thread;

  const nextRefs = {
    base_sha: input.to.baseCommit,
    start_sha: input.to.baseCommit,
    head_sha: input.to.sourceCommit,
  };
  if (target.change_position) {
    return {
      ...input.thread,
      target: {
        ...target,
        change_position: { ...target.change_position, ...nextRefs },
      },
    };
  }

  if (!gitLabDiffPositionRows(target.position)) {
    throw new Error(
      `Code thread ${input.thread.threadId} has an invalid text position.`,
    );
  }
  let position: GitLabDiffPosition = { ...target.position, ...nextRefs };
  for (const side of ["base", "head"] as const) {
    const transition = input.transitions.get(side);
    if (!transition) continue;
    const location = codePositionSideLocation(target.position, side);
    if (!location) continue;
    if (location.commit !== transition.fromCommit) {
      // The thread sits at some commit other than the pin this transition
      // starts from, so these diff summaries cannot carry it forward. That is
      // the outdated case, not a broken one: detach it like a failed mapping.
      return {
        ...input.thread,
        target: {
          ...target,
          change_position: position,
        },
      };
    }
    const mapped = await mapCodeLocation({
      rootPath: input.rootPath,
      location,
      toCommit: transition.toCommit,
      summaries: input.summaries.get(side) ?? [],
    });
    if (!mapped.newPath || !mapped.newSpan) {
      return {
        ...input.thread,
        target: {
          ...target,
          change_position: position,
        },
      };
    }
    position = mappedSidePosition({
      position,
      side,
      newPath: mapped.newPath,
      newSpan: mapped.newSpan,
      refs: nextRefs,
    });
  }
  return {
    ...input.thread,
    target: {
      ...target,
      position,
    },
  };
}

function codePositionSideLocation(
  position: GitLabDiffPosition,
  side: "base" | "head",
): CodeLocation | null {
  const rows = gitLabDiffPositionRows(position);
  if (!rows) return null;
  const lines = [rows.start, rows.end]
    .map((row) => (side === "base" ? row.old_line : row.new_line))
    .filter((line): line is number => line !== null);
  if (lines.length === 0) return null;
  const path = side === "base" ? position.old_path : position.new_path;
  const commit =
    side === "base"
      ? (position.base_sha ?? position.start_sha)
      : position.head_sha;
  if (!path || !commit) return null;
  return {
    path,
    side,
    commit,
    span: {
      startLine: Math.min(...lines),
      endLine: Math.max(...lines),
    },
  };
}

function mappedSidePosition(input: {
  position: GitLabDiffPosition;
  side: "base" | "head";
  newPath: string;
  newSpan: CodeSpan;
  refs: { base_sha: string; start_sha: string; head_sha: string };
}): GitLabDiffPosition {
  const rows = gitLabDiffPositionRows(input.position);
  if (!rows) throw new Error("Code thread position must contain text rows.");
  const start = mappedRow(
    rows.start,
    input.side,
    sideLine(rows.start, input.side) === null ? null : input.newSpan.startLine,
  );
  const end = mappedRow(
    rows.end,
    input.side,
    sideLine(rows.end, input.side) === null ? null : input.newSpan.endLine,
  );
  return createGitLabTextDiffPosition({
    ...input.refs,
    old_path: input.side === "base" ? input.newPath : input.position.old_path!,
    new_path: input.side === "head" ? input.newPath : input.position.new_path!,
    start,
    end,
    ignore_whitespace_change: input.position.ignore_whitespace_change ?? false,
  });
}

export function mapCodePositionSideThroughHunks(input: {
  position: GitLabDiffPosition;
  side: "base" | "head";
  newPath: string;
  hunks: DiffHunk[];
  refs?: { base_sha: string; start_sha: string; head_sha: string };
}): GitLabDiffPosition | null {
  const location = codePositionSideLocation(input.position, input.side);
  if (!location) return null;
  const newSpan = mapCodeSpanThroughHunks(location.span, input.hunks);
  if (!newSpan) return null;
  return mappedSidePosition({
    position: input.position,
    side: input.side,
    newPath: input.newPath,
    newSpan,
    refs: input.refs ?? {
      base_sha: input.position.base_sha ?? input.position.start_sha!,
      start_sha: input.position.start_sha ?? input.position.base_sha!,
      head_sha: input.position.head_sha!,
    },
  });
}

function mappedRow(
  row: GitLabTextDiffRow,
  side: "base" | "head",
  line: number | null,
): GitLabTextDiffRow {
  if (line === null) return row;
  return side === "head"
    ? { ...row, new_line: line }
    : { ...row, old_line: line };
}

function sideLine(
  row: GitLabTextDiffRow,
  side: "base" | "head",
): number | null {
  return side === "base" ? row.old_line : row.new_line;
}

async function mapCodeLocation(input: {
  rootPath: string;
  location: CodeLocation;
  toCommit: string;
  summaries: LocalVcsDiffFileSummary[];
}): Promise<{ newPath: string | null; newSpan: CodeSpan | null }> {
  const summary = input.summaries.find(
    (candidate) =>
      candidate.previousPath === input.location.path ||
      (!candidate.previousPath && candidate.path === input.location.path),
  );
  if (!summary) {
    return { newPath: input.location.path, newSpan: input.location.span };
  }
  if (summary.status === "deleted") {
    return { newPath: null, newSpan: null };
  }
  const newPath = summary.path;
  const patch = await diffTrees({
    rootPath: input.rootPath,
    baseRef: input.location.commit,
    headRef: input.toCommit,
    paths: [...new Set([input.location.path, newPath])],
  });
  const newSpan = mapCodeSpanThroughHunks(
    input.location.span,
    parseUnifiedPatch(newPath, patch),
  );
  return { newPath, newSpan };
}

export function mapCodeSpanThroughHunks(
  span: CodeSpan,
  hunks: DiffHunk[],
): CodeSpan | null {
  const mappedLines: number[] = [];
  for (let line = span.startLine; line <= span.endLine; line += 1) {
    const mapped = mapOldLine(line, hunks);
    if (mapped === null) return null;
    mappedLines.push(mapped);
  }
  if (
    mappedLines.some(
      (line, index) => index > 0 && line !== mappedLines[index - 1]! + 1,
    )
  ) {
    return null;
  }
  return {
    startLine: mappedLines[0]!,
    endLine: mappedLines[mappedLines.length - 1]!,
  };
}

function mapOldLine(oldLine: number, hunks: DiffHunk[]): number | null {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines === 0) {
      if (oldLine <= hunk.oldStart) return oldLine + delta;
      delta += hunk.newLines;
      continue;
    }
    if (oldLine < hunk.oldStart) return oldLine + delta;
    if (oldLine < hunk.oldStart + hunk.oldLines) {
      const row = hunk.lines.find((line) => line.oldLine === oldLine);
      return row?.kind === "context" ? row.newLine : null;
    }
    delta += hunk.newLines - hunk.oldLines;
  }
  return oldLine + delta;
}
