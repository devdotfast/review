import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canvasLoaderSource, canvasTargets } from "./copy-canvas.mjs";
import { readTutorialRuntimeManifest } from "./stage-review-runtime.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
    wasmFile: "assets/libavoid.wasm",
    stylesheets: ["assets/canvas.css"],
  });

  assert.match(
    source,
    /export \{ clearReviewViewState, mountReviewCanvas \} from "\.\/assets\/canvas\.js";/,
  );
  assert.doesNotMatch(source, /reviewDocRuntimeUrl|doc-runtime/);
});

test("the tutorial manifest includes the packaged Review runtime assets", async () => {
  const tutorialManifest = await readTutorialRuntimeManifest(
    path.resolve(appRoot, "../../packages/review/tutorial"),
  );

  assert.ok(tutorialManifest.reviewFiles.includes("review.mdx"));
  assert.ok(
    tutorialManifest.reviewFiles.includes("authoring-conversation.json"),
  );
  assert.ok(tutorialManifest.requiredPaths.includes("software-map.ts"));
  assert.ok(tutorialManifest.requiredPaths.includes("git-stub/HEAD"));
  assert.ok(
    tutorialManifest.requiredPaths.includes(
      ".bundle/document/review-document.json",
    ),
  );
  assert.ok(
    tutorialManifest.requiredPaths.includes(
      ".bundle/software-map/head-map.json",
    ),
  );
  assert.ok(
    tutorialManifest.requiredPaths.includes(
      ".bundle/software-map/base-map.json",
    ),
  );
  assert.ok(
    tutorialManifest.requiredPaths.includes(
      ".bundle/software-map/manifest.json",
    ),
  );
});

test("macOS entitlement artifacts retain required app and helper permissions", async () => {
  const [appEntitlements, helperEntitlements, helperPluginEntitlements] =
    await Promise.all([
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
    ]);

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
});
