import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const contextKeys = read("../code-oss/src/vs/workbench/common/contextkeys.ts");
const reviewWorkbench = read("../code-oss/src/vs/review/browser/workbench.ts");
const editorContribution = read(
  "../code-oss/src/vs/workbench/browser/parts/editor/editor.contribution.ts",
);
const editorTabsControl = read(
  "../code-oss/src/vs/workbench/browser/parts/editor/editorTabsControl.ts",
);

test("Review marks its window so shared chrome can opt out", () => {
  assert.match(
    contextKeys,
    /export const IsReviewWindowContext = new RawContextKey<boolean>\('isReviewWindow', false/,
  );
  assert.match(
    reviewWorkbench,
    /IsReviewWindowContext\.bindTo\(contextKeyService\)\.set\(true\)/,
    "the Review workbench must set the context key it gates chrome on",
  );
});

test("the split editor toolbar icon is gated out of Review", () => {
  const splitToolItems = editorContribution.match(
    /appendEditorToolItem\(\s*\{\s*id: SPLIT_EDITOR,[\s\S]*?\n\);/g,
  );

  assert.equal(
    splitToolItems?.length,
    2,
    "expected the horizontal and vertical split toolbar registrations",
  );
  for (const item of splitToolItems) {
    assert.match(item, /IsReviewWindowContext\.toNegated\(\)/);
  }
});

test("Review renders no editor actions overflow menu", () => {
  const update = editorTabsControl.match(
    /protected updateEditorActionsToolbar\(\): void \{[\s\S]*?\n\t\}/,
  )?.[0];

  assert.ok(update, "expected updateEditorActionsToolbar");
  assert.match(
    update,
    /IsReviewWindowContext\.getValue\(this\.contextKeyService\) \? \[\] : secondary/,
    "Review must drop secondary actions so the toolbar shows no '...' button",
  );
  assert.match(
    update,
    /setActions\(prepareActions\(primary\), prepareActions\(visibleSecondary\)\)/,
  );
  assert.match(
    update,
    /this\.editorActionsToolbarHasActions = primary\.length > 0 \|\| visibleSecondary\.length > 0/,
    "the separator flag must track what is actually rendered",
  );
  // Review drops only the secondary actions. Primary actions still reach the
  // toolbar, which is what the diff moving into the Review tab gave up its
  // own EditorTitle item for.
  assert.match(update, /prepareActions\(primary\)/);
});
