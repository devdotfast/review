import assert from "node:assert/strict";
import test from "node:test";

import type { SearchResultData, SourceData } from "./reviewProtocol.js";
import { evidenceRows } from "./reviewSearchEvidence.js";

const source = (text: string): SourceData => ({
  text,
  regions: [
    {
      kind: "leaf",
      id: 1,
      fold_state_id: 1,
      alignment_id: 1,
      start: { line: 0, column: 0 },
      end: { line: 1, column: 0 },
      search_highlights: [{ line: 0, start_column: 2, end_column: 6 }],
    },
    {
      kind: "fold",
      id: 2,
      fold_state_id: 2,
      start: { line: 1, column: 0 },
      end: { line: 2, column: 0 },
      visibility: { collapsed: true },
      children: [
        {
          kind: "leaf",
          id: 3,
          fold_state_id: 3,
          alignment_id: 3,
          start: { line: 1, column: 0 },
          end: { line: 2, column: 0 },
        },
      ],
    },
  ],
});
function result(): SearchResultData {
  return {
    display: "rhs",
    scope: {
      repo: "/unused",
      baseWorktree: { commitId: "base", path: "/unused/base" },
      headWorktree: { commitId: "head", path: "/unused/head" },
    },
    file: { rhs: { path: "example.ts", oid: "a".repeat(40), mode: "100644" } },
    sources: { rhs: source("é🔎 match\nhidden\n") },
  };
}

test("head-only evidence preserves its lines, UTF-8 highlights, and nested folded context", () => {
  const evidence = result();
  const rows = evidenceRows(evidence);
  assert.ok(rows.every((row) => row.baseLine === undefined));
  assert.equal(rows[0].headLine, 1);
  assert.deepEqual(rows[0].highlights, [{ startColumn: 2, endColumn: 4 }]);
  assert.ok(!rows.some((row) => row.content === "hidden"));
  const fold = evidence.sources.rhs!.regions[1];
  fold.visibility = { collapsed: false };
  const expanded = evidenceRows(evidence);
  assert.equal(expanded[1].content, "hidden");
  assert.equal(expanded[1].headLine, 2);
  assert.equal(expanded[1].fold?.id, 2);
});

test("paired changed lines remain separate while unchanged aligned lines merge", () => {
  const evidence = result();
  evidence.display = "both";
  evidence.file = { lhs: evidence.file.rhs!, rhs: evidence.file.rhs! };
  evidence.sources = {
    lhs: source("é🔎 match\nhidden\n"),
    rhs: evidence.sources.rhs!,
  };
  assert.equal(evidenceRows(evidence)[0].baseLine, 1);
  assert.equal(evidenceRows(evidence)[0].headLine, 1);
  const leaf = evidence.sources.lhs!.regions[0];
  if (leaf.kind !== "leaf") throw new Error("Expected leaf");
  leaf.changed = [{ line: 0, start_column: 0, end_column: 2 }];
  const rows = evidenceRows(evidence);
  assert.equal(rows[0].kind, "deleted");
  assert.equal(rows[0].headLine, undefined);
  assert.equal(rows[1].baseLine, undefined);
});


test("display hides the counterpart without losing it, and shared sources keep folds", () => {
  const single = result();
  const shared: SearchResultData = {
    scope: single.scope, display: "rhs",
    file: {lhs: single.file.rhs!, rhs: single.file.rhs!},
    sources: {same: single.sources.rhs!},
  };
  assert.ok(evidenceRows(shared).every(row => row.baseLine === undefined));
  assert.equal(evidenceRows(shared)[1].fold?.collapsed, true);
  shared.display = "both";
  assert.equal(evidenceRows(shared)[0].baseLine, 1);
  assert.equal(evidenceRows(shared)[0].headLine, 1);
  assert.equal(evidenceRows(shared)[1].fold?.collapsed, true);
  const paired: SearchResultData = {...shared, display: "lhs", sources: {
    lhs: source("before\nhidden\n"), rhs: source("after\nhidden\n"),
  }};
  assert.ok(evidenceRows(paired).every(row => row.headLine === undefined));
  assert.equal(evidenceRows(paired)[0].content, "before");
  paired.display = "rhs";
  assert.equal(evidenceRows(paired)[0].content, "after");
});
