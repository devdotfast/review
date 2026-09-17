import { z } from "zod";

import type { Source } from "./source.js";

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

export interface CoverageProgress {
  state: "unread" | "partial" | "viewed";
  total: ChangeCounts;
  remaining: ChangeCounts;
}

export interface CoverageFile {
  path: string;
  previousPath?: string;
  fingerprint: string;
  changed: Coverage;
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
  sources?: readonly Source[],
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
  sources?: readonly Source[],
): CoverageProgress {
  const total = { additions: 0, deletions: 0 },
    remaining = { additions: 0, deletions: 0 };

  const count = (ranges: LineInterval[]) =>
    ranges.reduce((sum, [start, end]) => sum + end - start, 0);

  for (const file of files) {
    const scope = scopedCoverage(file, sources);
    total.additions += count(scope.head);
    total.deletions += count(scope.base);
    remaining.additions += count(
      subtractIntervals(scope.head, file.viewed.head),
    );
    remaining.deletions += count(
      subtractIntervals(scope.base, file.viewed.base),
    );
  }

  const size = total.additions + total.deletions,
    unread = remaining.additions + remaining.deletions;

  return {
    total,
    remaining,
    state:
      size > 0 && unread === 0
        ? "viewed"
        : unread < size
          ? "partial"
          : "unread",
  };
}

export function coverageSources(
  file: CoverageFile,
  coverage = file.viewed,
): Source[] {
  return (["base", "head"] as const).flatMap((side) =>
    coverage[side].map(([start, end]) => ({
      side,
      file: side === "base" ? (file.previousPath ?? file.path) : file.path,
      fromLine: start + 1,
      toLine: end,
    })),
  );
}
