import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { Event } from '../../base/common/event.js';
import { URI } from '../../base/common/uri.js';
import { CancellationError } from '../../base/common/errors.js';
import { Range } from '../../editor/common/core/range.js';
import { ITextModelService } from '../../editor/common/services/resolverService.js';
import { IDiffProviderFactoryService } from '../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import type { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import type { ReviewDiffLens } from '../common/reviewProtocol.js';
import type { ReviewDiffViewSource } from './reviewDiffViewService.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'MutationObserver', 'Element', 'navigator', 'customElements', 'UIEvent', 'MouseEvent', 'KeyboardEvent'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) as never;
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { ReviewDiffViewService } = await import('./reviewDiffViewService.js');

function setup(fail?: 'acquire' | 'diff' | 'cancel') {
	let active = 0, peak = 0, providers = 0, peakProviders = 0;
	const source: ReviewDiffViewSource = {
		files: async () => [],
		load: async () => ({ sourceUri: URI.parse('review:test'), entries: Array.from({ length: 150 }, (_, i) => ({
			file: { path: `${i}.ts`, status: 'modified', additions: 1, deletions: 1 },
			original: URI.parse(`review:/base/${i}.ts`), modified: URI.parse(`review:/head/${i}.ts`), goToFileResource: URI.parse(`review:/head/${i}.ts`),
		})) }),
	};
	const lens: ReviewDiffLens = { id: 'find', title: 'find', reviewId: 'review', version: 1, ranges: Array.from({ length: 150 }, (_, i) => ({ file: `${i}.ts`, side: 'head', fromLine: 1, toLine: 1 })) };
	const resolver = { async createModelReference(uri: URI) {
		if (fail === 'acquire' && uri.path === '/head/1.ts') throw new Error('read failed');
		active++; peak = Math.max(peak, active);
		let disposed = false;
		const alive = () => assert.equal(disposed, false, 'search used a disposed model');
		return { object: { textEditorModel: {
			uri,
			getLineCount() { alive(); return 1; },
			getLineContent() { alive(); return uri.path.includes('/head/') ? 'match' : 'old'; },
			findMatches() { alive(); return uri.path.includes('/head/') ? [{ range: new Range(1, 1, 1, 6) }] : []; },
		} }, dispose() { assert.equal(disposed, false); disposed = true; active--; } };
	} };
	const factory = { createDiffProvider() {
		providers++; peakProviders = Math.max(peakProviders, providers);
		return { onDidChange: Event.None, async computeDiff() {
			if (fail === 'diff') throw new Error('diff failed');
			if (fail === 'cancel') throw new CancellationError();
			return { changes: [], moves: [], identical: false, quitEarly: false };
		}, dispose() { providers--; } };
	} };
	function instantiation(overrides?: { get(key: unknown): unknown }): IInstantiationService {
		return {
			invokeFunction: (fn: (accessor: { get(key: unknown): unknown }) => unknown) => fn({ get: key => overrides?.get(key) ?? (key === ITextModelService ? resolver : key === IDiffProviderFactoryService ? factory : undefined) }),
			createChild: (services: { get(key: unknown): unknown }) => instantiation(services),
			dispose() {},
		} as unknown as IInstantiationService;
	}
	const run = () => ReviewDiffViewService.prototype.findDocument.call({ instantiationService: instantiation() } as never, lens, source, { text: 'match', isRegex: false, matchCase: false, wholeWord: false });
	return { run, counts: () => ({ active, peak, providers, peakProviders }) };
}

test('searching 150 files releases each model pair and provider before reading the next', async () => {
	const { run, counts } = setup();
	for (let i = 0; i < 3; i++) {
		const matches = await run();
		assert.equal(matches.length, 150);
		assert.equal(matches[149].file, '149.ts');
		assert.equal(matches[149].range.startLineNumber, 1);
		assert.deepEqual(counts(), { active: 0, peak: 2, providers: 0, peakProviders: 1 });
	}
});
for (const failure of ['acquire', 'diff', 'cancel'] as const) {
	test(`search releases acquired models and providers after ${failure} failure`, async () => {
		const { run, counts } = setup(failure);
		await assert.rejects(run(), failure === 'cancel' ? /Canceled/ : /failed/);
		assert.equal(counts().active, 0);
		assert.equal(counts().providers, 0);
	});
}
