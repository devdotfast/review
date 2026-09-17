import type { ReviewDiffFileWire, ReviewDiffLens } from './reviewProtocol.js';

/** Diagram evidence may provide context outside the comparison's changed-file list. */
export function lensFiles(files: readonly ReviewDiffFileWire[], lens?: ReviewDiffLens): readonly ReviewDiffFileWire[] {
  if (!lens || lens.wholeFiles) return files;
  const known = new Set(files.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));
  const context: ReviewDiffFileWire[] = [];
  for (const range of lens.ranges) {
    if (known.has(range.file)) continue;
    known.add(range.file);
    context.push({ path: range.file, status: 'unchanged', additions: 0, deletions: 0 });
  }
  return [...files, ...context];
}
