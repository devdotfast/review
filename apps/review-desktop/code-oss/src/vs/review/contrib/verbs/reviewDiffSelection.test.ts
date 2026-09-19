import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedMonacoDiff } from './reviewDiffSelection.js';

const model = (...lines: string[]) => ({ getLineCount: () => lines.length, getLineContent: (line: number) => { assert.ok(line >= 1 && line <= lines.length); return lines[line - 1]; } });
const replacement = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 };

test('copy from either pane retains both sides of a replacement and rename paths', () => {
  for (const side of ['base', 'head'] as const) {
    const diff = selectedMonacoDiff(model('before', 'old', 'after'), model('before', 'new', 'extra', 'after'), [replacement], side, 2, 2, 'old.ts', 'new.ts');
    assert.deepEqual(diff, { oldPath: 'old.ts', newPath: 'new.ts', oldStart: 2, newStart: 2, rows: [{ kind: 'deleted', text: 'old' }, { kind: 'added', text: 'new' }, { kind: 'added', text: 'extra' }] });
  }
});

test('context after a replacement retains correct base/head offsets', () => {
  const diff = selectedMonacoDiff(model('before', 'old', 'after'), model('before', 'new', 'extra', 'after'), [replacement], 'head', 4, 4, 'a.ts', 'a.ts');
  assert.equal(diff?.oldStart, 3); assert.equal(diff?.newStart, 4);
  assert.deepEqual(diff?.rows, [{ kind: 'unchanged', text: 'after' }]);
});

test('added and deleted files use zero-count opposite sides', () => {
  const addition = { originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 2 };
  const added = selectedMonacoDiff(model(''), model('a', 'b'), [addition], 'head', 1, 2, '', 'new.ts');
  assert.equal(added?.oldStart, 0); assert.deepEqual(added?.rows.map(row => row.kind), ['added', 'added']);
  const removed = selectedMonacoDiff(model('a', 'b'), model(''), [{ originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }], 'base', 1, 2, 'old.ts', '');
  assert.equal(removed?.newStart, 0); assert.deepEqual(removed?.rows.map(row => row.kind), ['deleted', 'deleted']);
});

test('selection crossing a deletion includes it, adjacent context alone does not', () => {
  const change = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 };
  const select = (from: number, to: number) => selectedMonacoDiff(model('a', 'removed', 'b'), model('a', 'b'), [change], 'head', from, to, 'a', 'a');
  assert.deepEqual(select(1, 2)?.rows.map(row => row.kind), ['unchanged', 'deleted', 'unchanged']);
  assert.deepEqual(select(2, 2)?.rows, [{ kind: 'unchanged', text: 'b' }]);
});

test('partial selection of a newly added file copies only selected lines', () => {
  const diff = selectedMonacoDiff(model(''), model('a', 'b', 'c'), [{ originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 }], 'head', 2, 2, '', 'new.ts');
  assert.equal(diff?.newStart, 2);
  assert.deepEqual(diff?.rows, [{ kind: 'added', text: 'b' }]);
});
