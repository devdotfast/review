import assert from 'node:assert/strict';
import test from 'node:test';
import { lensFiles } from './reviewLensFiles.js';
import { lensContextGaps } from './reviewLens.js';
import type { ReviewDiffFileWire, ReviewDiffLens } from './reviewProtocol.js';

const files: ReviewDiffFileWire[] = [{ path: 'renamed.ts', previousPath: 'old.ts', status: 'renamed', additions: 2, deletions: 1 }];
const lens: ReviewDiffLens = {
	id: 'lens', title: 'Context', sessionId: 'review', version: 1, ranges: [
		{ file: 'old.ts', side: 'base', fromLine: 2, toLine: 5 },
		{ file: 'context.ts', side: 'base', fromLine: 10, toLine: 12 },
		{ file: 'context.ts', side: 'head', fromLine: 10, toLine: 12 },
	]
};

test('diagram references add each unchanged file once, preserving rename identity', () => {
	const result = lensFiles(files, lens);
	assert.deepEqual(result, [...files, { path: 'context.ts', status: 'unchanged', additions: 0, deletions: 0 }]);
	assert.equal(files.length, 1);
});

test('clearing the lens and whole-file glob lenses do not introduce context files', () => {
	assert.equal(lensFiles(files), files);
	assert.equal(lensFiles(files, { ...lens, wholeFiles: true }), files);
});

test('an identical file exposes the referenced slice with three surrounding lines', () => {
	const gaps = lensContextGaps({ changes: [], moves: [], identical: true, quitEarly: false }, 30, 30, lens.ranges.filter(range => range.file === 'context.ts'));
	assert.deepEqual(gaps.map(gap => [gap.originalStart, gap.originalCount, gap.modifiedStart, gap.modifiedCount]), [[1, 6, 1, 6], [16, 15, 16, 15]]);
});
