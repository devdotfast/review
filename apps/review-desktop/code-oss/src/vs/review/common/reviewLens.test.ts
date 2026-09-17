import assert from 'node:assert/strict';
import test from 'node:test';
import { lensContextGaps } from './reviewLens.js';
import type { IDocumentDiff } from '../../editor/common/diff/documentDiffProvider.js';

const plain: IDocumentDiff = { changes: [], moves: [], identical: false, quitEarly: false };
test('a lens keeps disjoint attachments and hides the intervening code', () => {
  const gaps = lensContextGaps(plain, 100, 100, [
    {side:'head',file:'a.ts',fromLine:20,toLine:22},
    {side:'base',file:'a.ts',fromLine:70,toLine:72},
  ]);
  assert.deepEqual(gaps.map(gap => [gap.originalStart,gap.originalCount]), [[1,16],[26,41],[76,25]]);
});
test('one-sided inserted ranges use correspondence without hiding their opposite context', () => {
  const diff = {...plain, sourceLineAlignment: Array.from({length:50},(_,i) => [null,i] as const)};
  const gaps = lensContextGaps(diff, 0, 50, [{side:'head',file:'new.ts',fromLine:20,toLine:25}]);
  assert.deepEqual(gaps.map(gap => [gap.originalCount,gap.modifiedStart,gap.modifiedCount,gap.kind]), [[0,1,16,'inserted'],[0,29,22,'inserted']]);
});
test('structural folds within the lens survive, overlapping folds do not', () => {
  const inside = {originalStart:20,modifiedStart:20,originalCount:3,modifiedCount:3,label:'body'};
  const outside = {originalStart:1,modifiedStart:1,originalCount:20,modifiedCount:20};
  const gaps = lensContextGaps({...plain,contextGaps:[inside,outside]},100,100,[{side:'base',file:'a',fromLine:18,toLine:28}]);
  assert.ok(gaps.includes(inside));
  assert.ok(!gaps.includes(outside));
});

test('viewed folds never hide an unread counterpart, and do not overlap structural folds', async () => {
  const { viewedContextGaps } = await import('./reviewLens.js');
  const range = (side: 'base' | 'head', fromLine: number, toLine: number) => ({ side, file: 'a.ts', fromLine, toLine });
  const changed = [range('base', 3, 5), range('head', 3, 5)];
  assert.deepEqual(viewedContextGaps(plain, 10, 10, [range('head', 3, 5)], changed), []);
  const gaps = viewedContextGaps({ ...plain, contextGaps: [{ originalStart: 2, modifiedStart: 2, originalCount: 5, modifiedCount: 5, label: 'body' }] }, 10, 10, changed, changed);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].label, 'Viewed');
  assert.equal(gaps[0].modifiedCount, 3);
});
