import assert from 'node:assert/strict';
import test from 'node:test';
import { URI } from '../../base/common/uri.js';
import { selectLensEntries } from './reviewLens.js';
import type { ReviewDiffLens, ReviewDiffProgress, SearchResultData } from '../common/reviewProtocol.js';
import type { ReviewFilesEditorEntry } from './reviewFilesDiffView.js';

test('sections select their retained result after JSON transport without sharing editor identity', () => {
  const result: SearchResultData = {
    kind: 'rhs', scope: { repo: '/repo', baseWorktree: { path: '/base', commitId: 'base' }, headWorktree: { path: '/head', commitId: 'head' } },
    file: { rhs: { path: 'same.ts', oid: 'a'.repeat(40), mode: '100644' } },
    sources: { rhs: { text: 'selected', regions: [] } },
  };
  const original = URI.parse('review-api-source://review/same.ts?side=base');
  const modified = URI.parse('review-api-source://review/same.ts?side=head');
  const entries: ReviewFilesEditorEntry[] = [{ file: { path: 'same.ts', status: 'modified', additions: 1, deletions: 1 }, original: undefined, modified, goToFileResource: modified, evidence: result }];
  const lens: ReviewDiffLens = { id: 'lens', reviewId: 'review', title: 'Results', version: 1, targets: [{ kind: 'results', results: [result] }] };
  const sections: ReviewDiffProgress['sections'] = ['first', 'second'].map(id => ({ id, label: id, sources: [], state: 'unread', total: { additions: 1, deletions: 0 }, remaining: { additions: 1, deletions: 0 }, targets: JSON.parse(JSON.stringify(lens.targets)) }));
  const selected = selectLensEntries(entries, lens, sections);
  assert.equal(selected.length, 2);
  assert.ok(selected.every(entry => entry.original === undefined));
  assert.notEqual(selected[0].modified!.toString(), selected[1].modified!.toString());
  assert.deepEqual(selected.map(entry => entry.sectionId), ['first', 'second']);

  const ranged = selectLensEntries([{ ...entries[0], evidence: undefined, original }], { ...lens, targets: [{ kind: 'ranges', ranges: [{ file: 'same.ts', side: 'base', fromLine: 1, toLine: 1 }] }] }, undefined);
  assert.equal(ranged[0].modified, undefined);
  assert.equal(ranged[0].goToFileResource.toString(), original.toString());
});
