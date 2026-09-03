import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbench = await readFile(
  new URL("../code-oss/src/vs/review/browser/workbench.ts", import.meta.url),
  "utf8",
);
const quickAccess = await readFile(
  new URL(
    "../code-oss/src/vs/review/contrib/quickaccess/reviewQuickAccess.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);

test("routes palette keys through the workbench keybinding service", () => {
  assert.doesNotMatch(
    workbench,
    /addDisposableListener\(mainWindow,\s*['"]keydown['"]/,
  );
  assert.doesNotMatch(workbench, /reviewPaletteRequest/);
});

test("keeps extension-contributed commands visible in Review quick access", () => {
  assert.match(quickAccess, /IExtensionService/);
  assert.match(quickAccess, /extension\.contributes\?\.commands/);
  assert.match(quickAccess, /extensionCommands\.has\(commandId\)/);
});
