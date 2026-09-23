import { structuralChangeCounts } from "@dev.fast/review-protocol";
import { z } from "zod";

import type { FileLineRange } from "./source.js";

/** Zero-based, half-open intervals; always normalized at the storage boundary. */
export type LineInterval = [number, number];

export interface Coverage {
  base: LineInterval[];
  head: LineInterval[];
}

export const coverageSchema = z.object({
  base: z.array(
    z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  ),
  head: z.array(
    z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  ),
});

export interface ChangeCounts {
  additions: number;
  deletions: number;
}

/**
 * Changed lines that diffr folds by default count as done, the way the
 * reader's viewed marks do. `folded` is how many of the scope's lines are
 * done only because they are folded; `remaining` excludes them.
 * "folded" is the state of a scope with nothing left to read and nothing the
 * reader marked: all of it starts folded.
 */
export interface CoverageProgress {
  state: "unread" | "partial" | "viewed" | "folded";
  total: ChangeCounts;
  remaining: ChangeCounts;
  folded: ChangeCounts;
}

export interface CoverageFile {
  path: string;
  previousPath?: string;
  fingerprint: string;
  changed: Coverage;
  /** The changed lines diffr folds by default: every changed line of a file
   * it hides, or those under a region that starts collapsed. Absent without
   * structural data, where every changed line is left to read. */
  folded?: Coverage;
  viewed: Coverage;
}

export const emptyCoverage = (): Coverage => ({ base: [], head: [] });

export function unionIntervals(
  ranges: readonly LineInterval[],
): LineInterval[] {
  const result: LineInterval[] = [];

  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue;
    const last = result.at(-1);

    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }

  return result;
}

export function intersectIntervals(
  left: readonly LineInterval[],
  right: readonly LineInterval[],
): LineInterval[] {
  const result: LineInterval[] = [];

  const a = unionIntervals(left),
    b = unionIntervals(right);

  let i = 0,
    j = 0;

  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]),
      end = Math.min(a[i][1], b[j][1]);

    if (start < end) result.push([start, end]);

    if (a[i][1] < b[j][1]) i++;
    else j++;
  }

  return result;
}

export function subtractIntervals(
  left: readonly LineInterval[],
  right: readonly LineInterval[],
): LineInterval[] {
  const result: LineInterval[] = [];
  const removed = unionIntervals(right);

  for (const [start, end] of unionIntervals(left)) {
    let cursor = start;

    for (const [from, to] of removed) {
      if (to <= cursor) continue;

      if (from >= end) break;

      if (from > cursor) result.push([cursor, from]);
      cursor = Math.min(end, Math.max(cursor, to));
    }

    if (cursor < end) result.push([cursor, end]);
  }

  return result;
}

export function updateCoverage(
  current: Coverage,
  scope: Coverage,
  viewed: boolean,
): Coverage {
  const apply = (side: "base" | "head") =>
    viewed
      ? unionIntervals([...current[side], ...scope[side]])
      : subtractIntervals(current[side], scope[side]);

  return { base: apply("base"), head: apply("head") };
}

export function scopedCoverage(
  file: CoverageFile,
  sources?: readonly FileLineRange[],
): Coverage {
  if (!sources) return file.changed;

  const side = (side: "base" | "head") =>
    intersectIntervals(
      file.changed[side],
      sources.flatMap((source): LineInterval[] =>
        source.side === side &&
        source.file ===
          (side === "base" ? (file.previousPath ?? file.path) : file.path)
          ? [[source.fromLine - 1, source.toLine]]
          : [],
      ),
    );

  return { base: side("base"), head: side("head") };
}

export function coverageProgress(
  files: readonly CoverageFile[],
  sources?: readonly FileLineRange[],
): CoverageProgress {
  const total = { additions: 0, deletions: 0 },
    remaining = { additions: 0, deletions: 0 },
    folded = { additions: 0, deletions: 0 };

  for (const file of files) {
    const scope = scopedCoverage(file, sources);
    const counts = structuralChangeCounts(scope);

    const side = (side: "base" | "head") => {
      const unviewed = subtractIntervals(scope[side], file.viewed[side]);

      return {
        unread: subtractIntervals(unviewed, file.folded?.[side] ?? []),
        folded: intersectIntervals(unviewed, file.folded?.[side] ?? []),
      };
    };

    const base = side("base"),
      head = side("head");

    const unread = structuralChangeCounts({
      base: base.unread,
      head: head.unread,
    });

    const foldedCounts = structuralChangeCounts({
      base: base.folded,
      head: head.folded,
    });

    total.additions += counts.added;
    total.deletions += counts.removed;
    remaining.additions += unread.added;
    remaining.deletions += unread.removed;
    folded.additions += foldedCounts.added;
    folded.deletions += foldedCounts.removed;
  }

  return {
    total,
    remaining,
    folded,
    state: progressState(total, remaining, folded),
  };
}

/** Progress over several comparisons at once: the sums, and the same state
 * rule as one. */
export function mergeCoverageProgress(
  parts: readonly CoverageProgress[],
): CoverageProgress {
  const total = { additions: 0, deletions: 0 },
    remaining = { additions: 0, deletions: 0 },
    folded = { additions: 0, deletions: 0 };

  for (const part of parts) {
    total.additions += part.total.additions;
    total.deletions += part.total.deletions;
    remaining.additions += part.remaining.additions;
    remaining.deletions += part.remaining.deletions;
    folded.additions += part.folded.additions;
    folded.deletions += part.folded.deletions;
  }

  return {
    total,
    remaining,
    folded,
    state: progressState(total, remaining, folded),
  };
}

/** Done lines are the viewed and the folded ones; the state names which. */
function progressState(
  total: ChangeCounts,
  remaining: ChangeCounts,
  folded: ChangeCounts,
): CoverageProgress["state"] {
  const size = total.additions + total.deletions,
    unread = remaining.additions + remaining.deletions,
    viewed = size - unread - folded.additions - folded.deletions;

  if (size > 0 && unread === 0) return viewed > 0 ? "viewed" : "folded";

  return viewed > 0 ? "partial" : "unread";
}

export function coverageSources(
  file: CoverageFile,
  coverage = file.viewed,
): FileLineRange[] {
  return (["base", "head"] as const).flatMap((side) =>
    coverage[side].map(([start, end]) => ({
      side,
      file: side === "base" ? (file.previousPath ?? file.path) : file.path,
      fromLine: start + 1,
      toLine: end,
    })),
  );
}
