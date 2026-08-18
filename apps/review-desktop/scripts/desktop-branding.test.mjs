import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const product = JSON.parse(await readSource("../code-oss/product.json"));
const electronBuild = await readSource("../code-oss/build/lib/electron.ts");
const aboutPanel = await readSource(
  "../code-oss/src/vs/review/electron-main/reviewMenubar.ts",
);
const themePackage = JSON.parse(
  await readSource("../code-oss/extensions/review-themes/package.json"),
);
const canvasShell = await readSource(
  "../../../packages/progressive-review/app/src/desktop-entry.tsx",
);
const bugReportDialog = await readSource(
  "../../../packages/progressive-review/app/src/bug-report-dialog.tsx",
);

test("uses slash-form branding in Review Desktop display surfaces", () => {
  assert.equal(product.nameLong, "/dev/fast Review");
  assert.equal(product.win32NameVersion, "/dev/fast Review");
  assert.equal(themePackage.description, "Themes for /dev/fast Review.");

  assert.match(electronBuild, /productDisplayName: product\.nameLong/);
  assert.match(electronBuild, /companyName: '\/dev\/fast'/);
  assert.match(electronBuild, /Copyright \(C\) 2026 \/dev\/fast/);
  assert.match(aboutPanel, /Copyright © 2026 \/dev\/fast/);
  assert.match(canvasShell, />\/dev\/fast Review<\/div>/);
  assert.match(
    bugReportDialog,
    /Reports are sent securely to \/dev\/fast\. Only authorized\s+\/dev\/fast team members/,
  );
});

test("keeps compatibility-sensitive Desktop identifiers unchanged", () => {
  assert.equal(product.darwinBundleIdentifier, "dev.fast.review");
  assert.equal(product.updateUrl, "https://update.dev.fast");
  assert.equal(product.urlProtocol, "dev-fast-review");
  assert.equal(product.dataFolderName, ".dev-fast-review");
  assert.equal(product.sharedDataFolderName, ".dev-fast-review-shared");
});

test("uses Review.app instead of putting the branded name in paths", async () => {
  assert.equal(product.nameShort, "Review");
  assert.equal(product.win32DirName, "Review");
  assert.match(electronBuild, /productAppName: product\.nameShort/);

  const bundlePathSources = await Promise.all(
    [
      "../code-oss/build/darwin/create-dmg.ts",
      "../code-oss/build/darwin/create-universal-app.ts",
      "../code-oss/build/darwin/sign.ts",
      "../code-oss/scripts/code.sh",
      "../code-oss/scripts/code-cli.sh",
      "../code-oss/scripts/node-electron.sh",
      "../code-oss/scripts/test.sh",
      "../code-oss/scripts/chat-simulation/common/utils.js",
      "../code-oss/scripts/chat-simulation/test-chat-perf-regression.js",
      "../code-oss/test/automation/src/electron.ts",
      "./build.sh",
      "./run.sh",
      "./package-macos.sh",
      "./notarize-macos.sh",
      "./smoke-launch-packaged.mjs",
      "./validate-release-artifacts.mjs",
    ].map(readSource),
  );

  for (const source of bundlePathSources) {
    assert.doesNotMatch(source, /dev\.fast Review\.app/);
    assert.doesNotMatch(source, /product\.nameLong\s*\+\s*['"]\.app['"]/);
    assert.doesNotMatch(source, /\$\{product\.nameLong\}\.app/);
  }

  assert.match(await readSource("./package-macos.sh"), /Review\.app/);
  assert.match(await readSource("./notarize-macos.sh"), /Review\.app/);
  assert.match(await readSource("./smoke-launch-packaged.mjs"), /Review\.app/);
  assert.match(
    await readSource("./validate-release-artifacts.mjs"),
    /Review\.app/,
  );
});
