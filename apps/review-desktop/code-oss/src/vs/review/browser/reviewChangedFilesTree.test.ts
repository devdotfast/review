/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

import type { ReviewDiffFileWire, ReviewDiffProgressFile, StructuralLineCounts } from '../common/reviewProtocol.js';

// jsdom ships no types here; the DOM globals below are all this test reads from it.
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'MutationObserver', 'Element', 'navigator', 'customElements', 'UIEvent', 'MouseEvent', 'KeyboardEvent'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) as never;
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { ChangedFilesTreeRenderer } = await import('./reviewChangedFilesTree.js');

const file = (path: string): ReviewDiffFileWire => ({ path, status: 'modified', additions: 3, deletions: 1 } as ReviewDiffFileWire);
const progress = (path: string, state: ReviewDiffProgressFile['state'], remaining: number): ReviewDiffProgressFile => ({
	path, state, remaining: { additions: remaining, deletions: 0 }, total: { additions: 3, deletions: 1 }, viewedRanges: [], changedRanges: [],
});

function row(state: ReviewDiffProgressFile['state'] | undefined, counts?: StructuralLineCounts) {
	const path = 'src/a.ts';
	const renderer = new ChangedFilesTreeRenderer(
		new Map(counts ? [[path, counts]] : []),
		new Map(state ? [[path, progress(path, state, state === 'unread' ? 3 : 0)]] : []),
		new Map(),
	);
	const template = renderer.renderTemplate(document.createElement('div'));
	renderer.renderElement({ element: { kind: 'file', name: 'a.ts', file: file(path) } } as never, 0, template);
	return { row: template.row, counts: template.counts.textContent };
}

test('a folded file reads as done: greyed like a viewed one, "Folded" in place of its counts', () => {
	const folded = row('folded');
	assert.equal(folded.counts, 'Folded');
	assert.ok(folded.row.classList.contains('review-file-folded'));
	assert.ok(!folded.row.classList.contains('review-file-viewed'));
});

test('a viewed file says "Viewed" in place of its counts', () => {
	const viewed = row('viewed');
	assert.equal(viewed.counts, 'Viewed');
	assert.ok(viewed.row.classList.contains('review-file-viewed'));
});

test('a file with changes left to read shows its remaining counts, not greyed', () => {
	const unread = row('unread');
	assert.equal(unread.counts, '+3−0');
	assert.ok(!unread.row.classList.contains('review-file-folded'));
	assert.ok(!unread.row.classList.contains('review-file-viewed'));
});

test('without progress, the structural counts show and nothing reads as folded', () => {
	const pending = row(undefined, { added: 4, removed: 1 });
	assert.equal(pending.counts, '+4−1');
	assert.ok(!pending.row.classList.contains('review-file-folded'));
});
