import type { WhiteboardDiffFileWire, WhiteboardDiffLens } from './whiteboardProtocol.js';

/** Diagram evidence may provide context outside the comparison's changed-file list. */
export function lensFiles(files: readonly WhiteboardDiffFileWire[], lens?: WhiteboardDiffLens): readonly WhiteboardDiffFileWire[] {
	if (!lens || lens.wholeFiles) return files;
	const known = new Set(files.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));
	const context: WhiteboardDiffFileWire[] = [];
	for (const range of lens.ranges) {
		if (known.has(range.file)) continue;
		known.add(range.file);
		context.push({ path: range.file, status: 'unchanged', additions: 0, deletions: 0 });
	}
	return [...files, ...context];
}
