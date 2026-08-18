import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canvasLoaderSource, canvasTargets } from "./copy-canvas.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production build configurations include the Review entrypoint and CSS", async () => {
  const [legacyBuild, nextBuild, workbenchHtml, workbenchDevHtml] =
    await Promise.all([
      readFile(path.join(appRoot, "code-oss/build/buildfile.ts"), "utf8"),
      readFile(path.join(appRoot, "code-oss/build/next/index.ts"), "utf8"),
      readFile(
        path.join(
          appRoot,
          "code-oss/src/vs/code/electron-browser/workbench/workbench.html",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          appRoot,
          "code-oss/src/vs/code/electron-browser/workbench/workbench-dev.html",
        ),
        "utf8",
      ),
    ]);

  assert.match(
    legacyBuild,
    /createModuleDescription\('vs\/review\/review\.desktop\.main'\)/,
  );
  assert.match(
    legacyBuild,
    /createModuleDescription\('vs\/review\/electron-utility\/reviewDesktopHostMain'\)/,
  );
  assert.equal(
    nextBuild.match(/'vs\/review\/review\.desktop\.main'/g)?.length,
    3,
    "the next build needs Review in its entrypoint, CSS, and dependency-inlining selection",
  );
  assert.match(
    nextBuild,
    /'vs\/review\/electron-utility\/reviewDesktopHostMain'/,
  );
  assert.match(nextBuild, /inlineReviewBrowserDependenciesPlugin/);
  assert.match(nextBuild, /eventsource-parser\|zod/);
  assert.match(
    workbenchHtml,
    /href="\.\.\/\.\.\/\.\.\/review\/review\.desktop\.main\.css"/,
  );
  assert.match(workbenchHtml, /\breviewDocumentModule\b/);
  assert.match(workbenchDevHtml, /\breviewDocumentModule\b/);
  assert.match(workbenchHtml, /\breviewLibavoid\b/);
  assert.match(workbenchDevHtml, /\breviewLibavoid\b/);
  assert.match(workbenchHtml, /script-src[\s\S]*?'trusted-types-eval'/);
  assert.match(workbenchDevHtml, /script-src[\s\S]*?'trusted-types-eval'/);
  assert.match(workbenchHtml, /connect-src[\s\S]*?vscode-file:/);
  assert.match(workbenchDevHtml, /connect-src[\s\S]*?vscode-file:/);
});

test("canvas targets are derived from fixed output locations", () => {
  const fakeAppRoot = path.resolve("/tmp/review desktop");
  const packagedRoot = path.resolve("/tmp/review package");
  const packagedMacRoot = path.resolve("/tmp/Review.app");

  assert.deepEqual(canvasTargets([], fakeAppRoot), [
    path.join(fakeAppRoot, "code-oss/out/vs/review/canvas"),
  ]);
  assert.deepEqual(
    canvasTargets(["--packaged-root", packagedRoot], fakeAppRoot),
    [
      path.join(fakeAppRoot, "code-oss/out/vs/review/canvas"),
      path.join(packagedRoot, "resources/app/out/vs/review/canvas"),
    ],
  );
  // A macOS bundle nests its resources under Contents/; without this the mac
  // packaging script writes outside the bundle and refuses to continue.
  assert.deepEqual(
    canvasTargets(["--packaged-root", packagedMacRoot], fakeAppRoot),
    [
      path.join(fakeAppRoot, "code-oss/out/vs/review/canvas"),
      path.join(packagedMacRoot, "Contents/Resources/app/out/vs/review/canvas"),
    ],
  );
  assert.throws(
    () => canvasTargets(["--packaged-root", path.parse(packagedRoot).root]),
    /filesystem root/,
  );
  assert.throws(() => canvasTargets(["--output", packagedRoot]), /usage:/);
});

test("the canvas loader exposes transient view-state reset", () => {
  const source = canvasLoaderSource({
    canvasFile: "assets/canvas.js",
    docRuntimeFile: "assets/doc-runtime.js",
    wasmFile: "assets/libavoid.wasm",
    stylesheets: ["assets/canvas.css"],
  });

  assert.match(
    source,
    /export \{ clearReviewViewState, mountReviewCanvas \} from "\.\/assets\/canvas\.js";/,
  );
});

test("M5 launches the packaged Review binary", async () => {
  const [packageScript, runScript] = await Promise.all([
    readFile(path.join(appRoot, "scripts/package-linux.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/run.sh"), "utf8"),
  ]);
  // The M5 acceptance harness stays in the private monorepo; a standalone
  // checkout skips its assertions.
  const [targetScript, acceptanceHarness] = await Promise.all([
    readFile(
      path.resolve(appRoot, "../../scripts/acceptance/start-m5-targets.sh"),
      "utf8",
    ).catch(() => undefined),
    readFile(
      path.resolve(appRoot, "../../scripts/acceptance/m5-ui.ts"),
      "utf8",
    ).catch(() => undefined),
  ]);

  assert.match(packageScript, /gulp -- vscode-linux-x64/);
  assert.match(packageScript, /--packaged-root "\$PACKAGED_ROOT"/);
  assert.match(packageScript, /reviewDesktopHostMain\.js/);
  assert.match(runScript, /DEV_FAST_REVIEW_PACKAGED_ROOT/);
  assert.match(runScript, /unset NODE_ENV VSCODE_DEV VSCODE_CLI/);
  assert.match(
    runScript,
    /STATE_ROOT="\$\{DEV_FAST_REVIEW_DESKTOP_STATE_ROOT:-\$REVIEW_BASE_HOME\/review-desktop\/state\}"/,
  );
  assert.match(runScript, /"--user-data-dir=\$STATE_ROOT\/user-data"/);
  assert.match(runScript, /"--extensions-dir=\$STATE_ROOT\/extensions"/);
  assert.ok(
    runScript.indexOf('"${CODE_ARGS[@]}"') < runScript.lastIndexOf("\n  ."),
    "Electron switches must precede the positional workspace argument",
  );
  if (targetScript !== undefined && acceptanceHarness !== undefined) {
    assert.match(targetScript, /DEV_FAST_REVIEW_PACKAGED_ROOT=/);
    assert.match(targetScript, /VSCode-linux-x64/);
    assert.ok(
      targetScript.indexOf('fixtures/m5-review/review.mdx" "$REVIEW_PATH"') <
        targetScript.indexOf(
          '"$ROOT/packages/progressive-review/dist/cli.js" start',
        ),
      "the M5 review must be seeded before the Review session compiles it",
    );
    assert.match(
      acceptanceHarness,
      /@dev-fast\/review-desktop app:package:linux/,
    );
  }
});

test("the packaged app carries its own Review runtime and is never written to at launch", async () => {
  const [
    buildScript,
    compileDarwinScript,
    darwinPayloadManifest,
    packageLinuxScript,
    packageMacScript,
    runScript,
    stagingScript,
    smokeScript,
  ] = await Promise.all([
    readFile(path.join(appRoot, "scripts/build.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/compile-darwin-payload.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/darwin-payload-manifest.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/package-linux.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/package-macos.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/run.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/stage-review-runtime.mjs"), "utf8"),
    readFile(path.join(appRoot, "scripts/smoke-launch-packaged.mjs"), "utf8"),
  ]);
  const requiredPayloadPaths = darwinPayloadManifest.slice(
    darwinPayloadManifest.indexOf("DARWIN_PAYLOAD_REQUIRED_PATHS=("),
    darwinPayloadManifest.indexOf("DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS=("),
  );

  // The runtime must be inside the bundle before signing, or the signature
  // covers an app that cannot start.
  assert.match(packageMacScript, /scripts\/stage-review-runtime\.mjs/);
  assert.match(
    buildScript,
    /--filter @dev\.fast\/review build/,
    "the Review Desktop build must produce the Review server",
  );
  assert.doesNotMatch(
    packageMacScript,
    /--filter @dev\.fast\/review build/,
    "macOS packaging must reuse the Review server build",
  );
  assert.ok(
    packageMacScript.indexOf("stage-review-runtime.mjs") <
      packageMacScript.indexOf("scripts/notarize-macos.sh"),
    "the Review runtime must be staged before the app is signed and notarized",
  );
  assert.match(
    packageMacScript,
    /review-runtime\/dist\/server\/desktop-host\.js/,
  );
  assert.match(packageMacScript, /@esbuild\/darwin-arm64\/bin\/esbuild/);
  for (const packageScript of [packageLinuxScript, packageMacScript]) {
    assert.doesNotMatch(
      packageScript,
      /extensions\/rust-lang\.rust-analyzer/,
      "release packages must not require optional Rust files",
    );
  }
  // The app distributes the Review CLI and agent skills; a bundle without
  // them silently reverts users to the npx flow.
  assert.match(packageMacScript, /review-runtime\/dist\/cli\.js/);
  assert.match(
    packageMacScript,
    /review-runtime\/skills\/dev-review\/SKILL\.md/,
  );
  assert.match(stagingScript, /"skills\/dev-review\/SKILL\.md"/);
  assert.match(stagingScript, /"tutorial\/review\.mdx"/);
  assert.match(stagingScript, /"tutorial\/software-map\.ts"/);
  assert.match(stagingScript, /"tutorial\/git-stub\/HEAD"/);
  assert.match(
    stagingScript,
    /"tutorial\/\.bundle\/document\/review-document\.js"/,
  );
  assert.match(
    stagingScript,
    /"tutorial\/\.bundle\/software-map\/manifest\.json"/,
  );
  assert.match(stagingScript, /RUNTIME_CLI_ENTRY = "dist\/cli\.js"/);

  // The icon step installs Assets.car and rewrites Info.plist, so it must come
  // after the runtime is staged and before signing. Out of order it either
  // ships the stock icon or invalidates the signature.
  assert.match(packageMacScript, /scripts\/apply-app-icon\.mjs/);
  assert.ok(
    packageMacScript.indexOf("stage-review-runtime.mjs") <
      packageMacScript.indexOf("apply-app-icon.mjs"),
    "the app icon must be applied after the Review runtime is staged",
  );
  assert.ok(
    packageMacScript.indexOf("apply-app-icon.mjs") <
      packageMacScript.indexOf("scripts/notarize-macos.sh"),
    "the app icon must be applied before the app is signed and notarized",
  );

  // A relocatable closure may not depend on the machine that produced it.
  assert.match(stagingScript, /--config\.inject-workspace-packages=true/);
  assert.match(stagingScript, /--ignore-scripts/);
  assert.match(stagingScript, /escapes runtime/);

  assert.match(
    requiredPayloadPaths,
    /packages\/progressive-review\/dist/,
    "the Darwin payload must carry the Review server build",
  );
  assert.match(
    requiredPayloadPaths,
    /packages\/progressive-review\/tutorial/,
    "the Darwin payload must carry the tutorial assets",
  );
  for (const packageScript of [packageLinuxScript, packageMacScript]) {
    assert.match(packageScript, /review-runtime\/tutorial\/review\.mdx/);
    assert.match(packageScript, /review-runtime\/tutorial\/data\.ts/);
    assert.match(packageScript, /review-runtime\/tutorial\/software-map\.ts/);
    assert.match(
      packageScript,
      /review-runtime\/tutorial\/sample-service\/package\.json/,
    );
    assert.match(packageScript, /review-runtime\/tutorial\/git-stub\/HEAD/);
    assert.match(
      packageScript,
      /review-runtime\/tutorial\/\.bundle\/document\/review-document\.js/,
    );
    assert.match(
      packageScript,
      /review-runtime\/tutorial\/\.bundle\/software-map\/manifest\.json/,
    );
  }
  assert.match(
    packageMacScript,
    /DARWIN_PAYLOAD_REQUIRED_PATHS\[@\]/,
    "precompiled macOS packaging must check the shared required paths",
  );

  // Linux builds local-vcs. The payload must transfer its output because the
  // macOS deploy disables lifecycle scripts.
  assert.match(requiredPayloadPaths, /packages\/local-vcs\/dist/);
  assert.match(
    stagingScript,
    /node_modules\/@dev\.fast\/local-vcs\/dist\/index\.js/,
  );
  for (const packageScript of [packageLinuxScript, packageMacScript]) {
    assert.match(
      packageScript,
      /review-runtime\/node_modules\/@dev\.fast\/local-vcs\/dist\/index\.js/,
    );
  }

  // The agent-session host belongs to development Review Desktop only.
  for (const productionInput of [
    requiredPayloadPaths,
    stagingScript,
    packageLinuxScript,
    packageMacScript,
  ]) {
    assert.doesNotMatch(
      productionInput,
      /@dev\.fast\/agent-session|packages\/agent-session/,
    );
  }

  // A renderer alone can hide a broken Review runtime. Release smoke must
  // also observe server readiness in the main log and print that log on error.
  assert.match(
    smokeScript,
    /hasRenderer\(userDataDir\) && SERVER_READY_PATTERN\.test\(mainLog\)/,
  );
  assert.match(smokeScript, /server host terminated:/);
  assert.match(smokeScript, /Cannot find \(\?:module\|package\)/);
  assert.match(smokeScript, /--- main log ---/);
  assert.match(smokeScript, /await closed/);
  assert.match(smokeScript, /maxRetries: 10/);

  // Nothing may inject bootstrap credentials into a packaged launch, and a
  // packaged launch may not write into the bundle.
  for (const injected of [
    "DEV_FAST_REVIEW_SERVER_URL",
    "DEV_FAST_REVIEW_SERVER_TOKEN",
    "DEV_FAST_REVIEW_INSTANCE_ID",
    "DEV_FAST_REVIEW_SERVER_PORT",
  ]) {
    assert.doesNotMatch(
      runScript,
      new RegExp(`export ${injected}`),
      `${injected} must come from the main process, not the launcher`,
    );
  }
  assert.doesNotMatch(runScript, /copy-canvas\.mjs --packaged-root/);
});

test("macOS release packaging signs, notarizes, and rebuilds stapled artifacts", async () => {
  const [
    packageMacScript,
    notarizeMacScript,
    signScript,
    appEntitlements,
    helperEntitlements,
    helperPluginEntitlements,
    packageJson,
  ] = await Promise.all([
    readFile(path.join(appRoot, "scripts/package-macos.sh"), "utf8"),
    readFile(path.join(appRoot, "scripts/notarize-macos.sh"), "utf8"),
    readFile(path.join(appRoot, "code-oss/build/darwin/sign.ts"), "utf8"),
    readFile(
      path.join(appRoot, "code-oss/build/darwin/entitlements/app.plist"),
      "utf8",
    ),
    readFile(
      path.join(appRoot, "code-oss/build/darwin/entitlements/helper.plist"),
      "utf8",
    ),
    readFile(
      path.join(
        appRoot,
        "code-oss/build/darwin/entitlements/helper-plugin.plist",
      ),
      "utf8",
    ),
    readFile(path.join(appRoot, "package.json"), "utf8"),
  ]);

  assert.doesNotMatch(signScript, /azure-pipelines/);
  assert.match(signScript, /import\.meta\.dirname, 'entitlements'/);
  for (const entitlement of [
    "app.plist",
    "helper.plist",
    "helper-gpu.plist",
    "helper-renderer.plist",
    "helper-plugin.plist",
  ]) {
    assert.match(signScript, new RegExp(entitlement.replace(".", "\\.")));
  }
  assert.match(signScript, /process\.env\['CODESIGN_KEYCHAIN'\]/);
  assert.match(signScript, /path\.join\(tempDir, 'buildagent\.keychain'\)/);
  assert.match(
    signScript,
    /ignore: filePath => isTutorialGitObjectPath\(appPath, filePath\)/,
    "compressed tutorial Git objects must not be signed as executables",
  );
  assert.match(
    signScript,
    /'review-runtime',\s*'tutorial',\s*'git-stub',\s*'objects'/,
    "the signing exclusion must cover only the tutorial Git object tree",
  );
  assert.match(appEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(appEntitlements, /com\.apple\.security\.device\.camera/);
  assert.match(
    appEntitlements,
    /com\.apple\.security\.automation\.apple-events/,
  );
  assert.match(helperEntitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(
    helperPluginEntitlements,
    /com\.apple\.security\.cs\.allow-unsigned-executable-memory/,
  );
  assert.match(
    helperPluginEntitlements,
    /com\.apple\.security\.cs\.disable-library-validation/,
  );

  assert.match(packageMacScript, /scripts\/notarize-macos\.sh/);
  assert.match(notarizeMacScript, /SKIP_NOTARIZE/);

  // A stored notarytool profile keeps the App Store Connect key out of the
  // environment and the process table, so it must stay supported alongside the
  // individual variables CI provides.
  assert.match(notarizeMacScript, /NOTARY_KEYCHAIN_PROFILE/);
  assert.match(notarizeMacScript, /--keychain-profile/);
  assert.doesNotMatch(
    notarizeMacScript,
    /notarytool submit[\s\S]{0,120}--password/,
    "credentials must be passed through NOTARY_ARGS, not inlined at the call site",
  );
  assert.match(
    notarizeMacScript,
    /node --experimental-strip-types "\$CHECKOUT\/build\/darwin\/sign\.ts"/,
  );

  // The signing identity ships alongside the other Apple credentials as
  // APPLE_SIGN_IDENTITY, but upstream's sign.ts only reads CODESIGN_IDENTITY.
  // Without this bridge, sourcing the Apple credentials is not enough to
  // notarize. sign.ts is a child process, so the value must be exported, and an
  // explicit CODESIGN_IDENTITY must still win.
  assert.match(
    notarizeMacScript,
    /if \[\[ -z "\$\{CODESIGN_IDENTITY:-\}" && -n "\$\{APPLE_SIGN_IDENTITY:-\}" \]\]; then\n\s*export CODESIGN_IDENTITY="\$APPLE_SIGN_IDENTITY"/,
  );
  assert.ok(
    notarizeMacScript.indexOf(
      'export CODESIGN_IDENTITY="$APPLE_SIGN_IDENTITY"',
    ) < notarizeMacScript.indexOf("REQUIRED_VARIABLES"),
    "the identity bridge must run before the required-variable check reads it",
  );
  assert.match(
    notarizeMacScript,
    /\$CODESIGN_IDENTITY or \\\$APPLE_SIGN_IDENTITY must be set/,
    "the failure message must name both accepted variables",
  );
  assert.match(notarizeMacScript, /codesign --verify --deep --strict/);
  assert.match(notarizeMacScript, /ditto -c -k --keepParent/);
  assert.match(notarizeMacScript, /xcrun notarytool submit/);
  assert.match(notarizeMacScript, /Review-darwin-arm64-\$VERSION\.zip/);
  assert.match(notarizeMacScript, /hdiutil create/);
  assert.match(notarizeMacScript, /submit_notarization "\$DMG" dmg/);
  assert.match(notarizeMacScript, /xcrun stapler staple "\$DMG"/);
  assert.match(
    notarizeMacScript,
    /spctl -a -vv --type open --context context:primary-signature "\$DMG"/,
  );

  // One Apple submission: the DMG ticket covers the nested app.
  assert.match(notarizeMacScript, /submit_notarization "\$DMG" dmg/);
  assert.doesNotMatch(
    notarizeMacScript,
    /submit_notarization "\$SUBMISSION_ZIP" app/,
  );

  // The DMG is built and signed before the submission.
  assert.ok(
    notarizeMacScript.indexOf("hdiutil create") <
      notarizeMacScript.indexOf('submit_notarization "$DMG" dmg'),
    "the DMG must exist before it is submitted for notarization",
  );

  // Both artifacts are stapled after the submission.
  assert.ok(
    notarizeMacScript.indexOf('submit_notarization "$DMG" dmg') <
      notarizeMacScript.indexOf('xcrun stapler staple "$PACKAGED_APP"'),
    "the app is stapled from the DMG submission's ticket",
  );

  // The update zip ships the stapled app.
  assert.ok(
    notarizeMacScript.indexOf('xcrun stapler staple "$PACKAGED_APP"') <
      notarizeMacScript.indexOf(
        'ditto -c -k --keepParent "$PACKAGED_APP" "$UPDATE_ZIP"',
      ),
    "the update zip must be rebuilt after the app is stapled",
  );
  assert.equal(
    JSON.parse(packageJson).scripts["app:notarize:macos"],
    "bash scripts/notarize-macos.sh",
  );
});
