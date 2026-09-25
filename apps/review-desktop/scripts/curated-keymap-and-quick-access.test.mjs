import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const curatedExtensions = await readFile(
  new URL(
    "../code-oss/src/vs/review/contrib/extensions/reviewCuratedExtensions.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);

test("drives curated keymap defaults from review.keymap", () => {
  assert.match(
    curatedExtensions,
    /getValue<ReviewKeymap>\(REVIEW_KEYMAP_SETTING\)/,
  );
  assert.match(curatedExtensions, /defaultsApplied\.v2/);
});
