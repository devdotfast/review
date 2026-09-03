import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const quickAccess = await readFile(
  new URL(
    "../code-oss/src/vs/review/contrib/quickaccess/reviewQuickAccess.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);
const curatedExtensions = await readFile(
  new URL(
    "../code-oss/src/vs/review/contrib/extensions/reviewCuratedExtensions.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);

test("keeps extension-contributed commands visible in Review quick access", () => {
  assert.match(quickAccess, /IExtensionService/);
  assert.match(quickAccess, /extension\.contributes\?\.commands/);
  assert.match(quickAccess, /extensionCommands\.has\(commandId\)/);
});

test("drives curated keymap defaults from review.keymap", () => {
  assert.match(curatedExtensions, /getValue<ReviewKeymap>/);
  assert.match(curatedExtensions, /defaultsApplied\.v2/);
});
