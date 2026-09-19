import { posix } from "node:path";

import type { ReviewDiffLensTarget } from "@dev.fast/review-protocol";

import { evidenceSources, type Source } from "../source.js";
import {
  type CoverageFile,
  coverageSources,
  unionIntervals,
  scopedCoverage,
  subtractIntervals,
} from "../viewed-coverage.js";
import { fileLensTargets, type FileLensBlock } from "./blocks/file_lens.js";

/** Subtract authored coverage, independently of viewed state. */
export function uncategorizedSources(
  files: readonly CoverageFile[],
  sources: readonly Source[],
): Source[] {
  return files.flatMap((file) => {
    const covered = scopedCoverage(file, sources);
    return coverageSources(file, {
      base: subtractIntervals(file.changed.base, covered.base),
      head: subtractIntervals(file.changed.head, covered.head),
    });
  });
}

/** Resolve all targets into one union; a whole-file range subsumes narrower ranges. */
export function resolveFileLens(
  block: FileLensBlock,
  files: readonly CoverageFile[],
  fileSources: ReadonlyMap<string, Source[]>,
) {
  const targets = fileLensTargets(block);
  const displayTargets: ReviewDiffLensTarget[] = targets.map((target) => {
    if (target.kind === "results") return target;
    return {
      kind: "ranges",
      ranges:
        target.kind === "ranges"
          ? target.sources
          : files
              .filter((file) => matchesFileLens(target.patterns, file))
              .flatMap((file) => fileSources.get(file.path) ?? []),
    };
  });
  const selected = displayTargets.flatMap((target) =>
    target.kind === "ranges"
      ? [...target.ranges]
      : target.results.flatMap(evidenceSources),
  );
  const groups = new Map<string, Source[]>();
  for (const source of selected) {
    const key = JSON.stringify([source.side, source.file]);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  const sources = [...groups.values()].flatMap((group) =>
    unionIntervals(
      group.map((source) => [source.fromLine - 1, source.toLine]),
    ).map(([start, end]) => ({
      ...group[0],
      fromLine: start + 1,
      toLine: end,
    })),
  );
  const fileCount = new Set(
    sources.map(
      (source) =>
        files.find(
          (file) =>
            source.file ===
            (source.side === "base"
              ? (file.previousPath ?? file.path)
              : file.path),
        )?.path ?? source.file,
    ),
  ).size;
  return {
    targets: displayTargets,
    sources,
    fileCount,
    wholeFiles: targets.every((target) => target.kind === "files"),
  };
}

/** Evaluate authored patterns against the changed-file list, never the filesystem. */
export function matchesFileLens(
  patterns: readonly string[],
  file: { path: string; previousPath?: string },
): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern;

    return [file.path, file.previousPath].some(
      (path) =>
        path !== undefined &&
        (path === normalized || posix.matchesGlob(path, normalized)),
    );
  });
}
