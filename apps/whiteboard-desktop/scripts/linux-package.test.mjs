import assert from "node:assert/strict";
import test from "node:test";

import { whiteboardPackage } from "../code-oss/build/linux/review-package.ts";
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
