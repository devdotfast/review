/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { projectSourceAlignment } from "../../editor/common/diff/sourceLineAlignment.js";
import {
  nativeFoldRange,
  structuralRows,
  utf16Column,
  type StructuralDiff,
} from "./reviewStructuralDiff.js";

test("paired collapse removes hidden height without leaving padding for hidden anchors", () => {
  const rows: [number | null, number | null][] = [
    [0, 0],
    [1, 1],
    [null, 2],
    [2, 3],
    [3, 4],
  ];
  const segments = projectSourceAlignment(
    rows,
    (l) => (l === 1 || l === 2 ? 0 : 20),
    (r) => (r >= 1 && r <= 3 ? 0 : 20),
  );
  assert.deepEqual(
    segments.map((s) => [s.leftEnd, s.rightEnd, s.rightHeight - s.leftHeight]),
    [
      [3, 4, 0],
      [4, 5, 0],
    ],
  );
});

test("one-sided collapse pads before the next surviving anchor", () => {
  const segments = projectSourceAlignment(
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    (l) => (l === 1 ? 0 : 20),
    () => 20,
  );
  assert.equal(segments[0].rightHeight - segments[0].leftHeight, 20);
  assert.equal(segments[1].leftStart, 2);
  assert.equal(segments[1].rightStart, 2);
});

test("wrapping contributes height without changing correspondence", () => {
  const segments = projectSourceAlignment(
    [
      [0, 0],
      [1, 1],
    ],
    () => 20,
    (r) => (r === 0 ? 60 : 20),
  );
  assert.equal(segments[0].rightHeight - segments[0].leftHeight, 40);
  assert.equal(segments[1].leftStart, 1);
});

test("hunk alignment survives context overlap and fills omitted context", () => {
  const diff = {
    lhs_src: { Text: "a\nb\nc\nd\n" },
    rhs_src: { Text: "a\nx\nb\nc\nd\n" },
    hunks: [
      {
        lines: [
          [0, 0],
          [null, 1],
          [1, 2],
        ],
      },
      {
        lines: [
          [1, 2],
          [2, 3],
        ],
      },
    ],
  } as StructuralDiff;
  assert.deepEqual(structuralRows(diff), [
    [0, 0],
    [null, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ]);
});

test("fold endpoints are exclusive and inline ranges cannot become native line folds", () => {
  assert.deepEqual(
    nativeFoldRange({ start: { line: 2, byte_column: 0 }, end: { line: 5, byte_column: 0 } }),
    { start: 3, end: 5 },
  );
  assert.equal(
    nativeFoldRange({ start: { line: 2, byte_column: 1 }, end: { line: 2, byte_column: 8 } }),
    undefined,
  );
});

test("Tree-sitter byte offsets convert to Monaco UTF-16 columns", () => {
  assert.equal(utf16Column("a😀éz", 7), 5);
  assert.throws(() => utf16Column("a😀éz", 2), /UTF-8 boundary/);
});
