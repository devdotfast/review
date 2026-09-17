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

test("macOS entitlement artifacts retain required app and helper permissions", async () => {
  const required = {
    app: ["device.audio-input", "device.camera", "automation.apple-events"],
    helper: ["cs.allow-jit"],
    "helper-plugin": [
      "cs.allow-unsigned-executable-memory",
      "cs.disable-library-validation",
    ],
  };

  for (const [name, permissions] of Object.entries(required)) {
    const plist = await readFile(
      path.join(appRoot, `code-oss/build/darwin/entitlements/${name}.plist`),
      "utf8",
    );

    for (const permission of permissions) {
      assert.ok(
        plist.includes(`com.apple.security.${permission}`),
        `${name}: ${permission}`,
      );
    }
  }
});
