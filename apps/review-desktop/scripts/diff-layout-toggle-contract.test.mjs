import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editorContribution = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/browser/parts/editor/editor.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);

const diffCommandsService = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/browser/parts/editor/diffEditorCommandsService.ts",
    import.meta.url,
  ),
  "utf8",
);

const reviewWorkbenchMain = readFileSync(
  new URL(
    "../code-oss/src/vs/review/review.common.main.ts",
    import.meta.url,
  ),
  "utf8",
);

test("native diff editors expose the canonical inline/split toolbar toggle", () => {
  const toggleMenuItem = editorContribution.match(
    /MenuRegistry\.appendMenuItem\(MenuId\.EditorTitle, \{\s*command: \{\s*id: TOGGLE_DIFF_SIDE_BY_SIDE,[\s\S]*?\n\}\);/,
  )?.[0];

  assert.ok(toggleMenuItem, "expected the diff layout editor-title action");
  assert.match(toggleMenuItem, /icon: Codicon\.diffSidebyside/);
  assert.match(toggleMenuItem, /Show Inline Diff/);
  assert.match(toggleMenuItem, /Show Side by Side Diff/);
  assert.match(toggleMenuItem, /config\.diffEditor\.renderSideBySide/);
  assert.match(
    toggleMenuItem,
    /group: 'navigation'/,
    "expected the layout toggle in the visible native editor toolbar",
  );

  assert.match(
    diffCommandsService,
    /updateValue\(modifiedResource, key, !value\)/,
  );
  assert.match(
    reviewWorkbenchMain,
    /parts\/editor\/diffEditor\.workbench\.contribution\.js/,
    "Review must register the service backing the native toggle command",
  );
});
