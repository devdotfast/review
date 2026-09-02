import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const contribution = read(
  "../code-oss/src/vs/review/contrib/install/reviewCliInstall.contribution.ts",
);
const desktopContribution = read(
  "../code-oss/src/vs/workbench/electron-browser/desktop.contribution.ts",
);
const nativeHost = read(
  "../code-oss/src/vs/platform/native/electron-main/nativeHostMainService.ts",
);

test("registers the Review CLI PATH action", () => {
  assert.match(contribution, /id: 'review\.installCliInPath'/);
  assert.match(contribution, /Review: Install CLI in PATH/);
  assert.match(
    contribution,
    /uninstallShellCommand\(\{ commandName: 'review', symlinkOnly: true \}\)/,
  );
  assert.match(
    contribution,
    /applyCliInstall\(\{ targets: \[\], shim: true \}\)/,
  );
});

test("suppresses the inherited editor shell commands for Review", () => {
  assert.match(
    desktopContribution,
    /if \(isMacintosh && !product\.reviewVersion\) \{[\s\S]*registerAction2\(InstallShellScriptAction\);[\s\S]*registerAction2\(UninstallShellScriptAction\);/,
  );
});

test("legacy cleanup is constrained to a validated symlink", () => {
  assert.match(nativeHost, /\^\[A-Za-z0-9\._-\]\+\$/);
  assert.match(
    nativeHost,
    /commandName === '\.' \|\| commandName === '\.\.'/,
  );
  assert.match(nativeHost, /if \(options\?\.symlinkOnly\)/);
  assert.match(nativeHost, /Refusing to remove.*not a symbolic link/);
});
