import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareReviewRpmPackage,
  whiteboardPackage,
} from "../code-oss/build/linux/review-package.ts";
import { releaseIdentityFor } from "./release-channel.mjs";

const product = (quality) => ({ quality, ...releaseIdentityFor(quality) });

test("stable versions package as dev-fast-review", () => {
  assert.deepEqual(whiteboardPackage(product("stable"), "1.2.3", "2"), {
    name: "dev-fast-review",
    app: "review",
    appName: "Whiteboard",
    appId: "dev.fast.review",
    rpmVersion: "1.2.3",
    revision: "2",
    file: "dev-fast-review-1.2.3-2.x86_64.rpm",
  });
});

test("preview versions package separately with a tilde RPM version", () => {
  assert.deepEqual(
    whiteboardPackage(product("preview"), "1.2.4-preview.20260922.7", "1"),
    {
      name: "dev-fast-review-preview",
      app: "review-preview",
      appName: "Whiteboard Preview",
      appId: "dev.fast.review.preview",
      rpmVersion: "1.2.4~preview.20260922.7",
      revision: "1",
      file: "dev-fast-review-preview-1.2.4~preview.20260922.7-1.x86_64.rpm",
    },
  );
});

test("the payload quality must match the version shape", () => {
  assert.throws(
    () => whiteboardPackage(product("stable"), "1.2.4-preview.20260922.7", "1"),
    /quality "stable" does not match/,
  );
  assert.throws(
    () => whiteboardPackage(product("preview"), "1.2.4", "1"),
    /quality "preview" does not match/,
  );
  assert.throws(() => whiteboardPackage(product("stable"), "1.2.4-rc.1", "1"));
  assert.throws(() => whiteboardPackage(product("stable"), "1.2.4", "0"));
});

for (const quality of ["stable", "preview"]) {
  test(`${quality} RPM staging installs the channel's shipped icon`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "whiteboard-rpm-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const appRoot = path.join(root, "apps/whiteboard-desktop");
    const codeRoot = path.join(appRoot, "code-oss");
    const payload = path.join(appRoot, "VSCode-linux-x64");

    const version =
      quality === "preview" ? "1.2.4-preview.20260922.7" : "1.2.3";

    await mkdir(path.join(payload, "resources/app"), { recursive: true });
    await writeFile(
      path.join(appRoot, "package.json"),
      JSON.stringify({ version }),
    );
    await writeFile(
      path.join(payload, "resources/app/product.json"),
      JSON.stringify({
        ...product(quality),
        reviewVersion: version,
        commit: "a".repeat(40),
      }),
    );
    await writeFile(path.join(payload, "chrome-sandbox"), "sandbox fixture");
    const icons = path.join(root, "packages/whiteboard/app/icons");
    await cp(
      new URL("../../../packages/whiteboard/app/icons/", import.meta.url),
      icons,
      { recursive: true },
    );

    await prepareReviewRpmPackage(codeRoot, "x86_64");

    const iconName =
      quality === "preview" ? "whiteboard-preview" : "whiteboard";

    const installed = path.join(
      codeRoot,
      ".build/linux/rpm/x86_64/rpmbuild/BUILD/usr/share/icons/hicolor/512x512/apps",
      `${product(quality).applicationName}.png`,
    );

    assert.deepEqual(
      await readFile(installed),
      await readFile(path.join(icons, `${iconName}-square-512.png`)),
    );
  });
}
