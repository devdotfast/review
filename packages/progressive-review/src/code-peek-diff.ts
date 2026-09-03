import type { CodePeekDiffPayload } from "./authoring";
import type { SourceSnapshot } from "./source-code-types";
import {
  codePeekRootSourceRanges,
  sliceReviewDiffFileToCodePeekRanges,
} from "./codepeek-symbol-diff";
import type { ReviewDiffFile } from "./review-diff-files";

/**
 * The diff summary a code peek carries: the pinned range's slice of the
 * review's diff, one entry per file the peek touches. Shared by the desktop
 * server (per request) and publish (once, embedded into the bundle).
 */
export function codePeekDiffFromFiles(input: {
  snapshot: SourceSnapshot;
  files: readonly ReviewDiffFile[];
  baseRef?: string;
  headRef?: string;
  graph: "head" | "base";
  includePatch: boolean;
}): CodePeekDiffPayload | undefined {
  if (!input.baseRef) return undefined;
  const ranges = codePeekRootSourceRanges(input.snapshot);
  const paths = new Set(
    ranges.map((range) => range.file).filter((file) => file.trim().length > 0),
  );
  if (paths.size === 0) return undefined;
  const files = input.files
    .filter((file) => paths.has(file.path) || (file.previousPath !== undefined && paths.has(file.previousPath)))
    .map((file) =>
      sliceReviewDiffFileToCodePeekRanges({
        file,
        ranges,
        orientation: input.graph,
        contextLines: 0,
      }),
    )
    .filter((file): file is ReviewDiffFile => file !== null);
  if (files.length === 0) return undefined;
  return {
    baseRef: input.baseRef,
    headRef: input.headRef,
    orientation: input.graph,
    files: files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(input.includePatch ? { patch: file.patch ?? "" } : {}),
    })),
  };
}

/** Stable key for a peek's resolution, shared by publish (writer) and the
    browser runtime (reader). */
export function codePeekResolutionKey(props: {
  graph?: "head" | "base";
  file: string;
  fromLine: number;
  toLine: number;
}): string {
  return `${props.graph ?? "head"}|${props.file}|${props.fromLine}|${props.toLine}`;
}
