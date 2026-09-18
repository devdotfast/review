import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  iconCacheKey,
  readIconCache,
  writeIconCache,
} from "./app-icon-cache.mjs";

test("cached icon installation tracks source, channel and bundle changes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "icon-cache-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Review.app");
  const source = path.join(root, "source.icon");
  const resources = path.join(appPath, "Contents", "Resources");
  const executable = path.join(appPath, "Contents", "MacOS", "Review");
  mkdirSync(resources, { recursive: true });
  mkdirSync(path.dirname(executable));
  writeFileSync(executable, "electron");
  writeFileSync(source, "artwork");
  writeFileSync(path.join(resources, "Assets.car"), "catalog");
  writeFileSync(path.join(resources, "Review.icns"), "fallback");

  const options = {
    appPath,
    iconName: "dev-fast",
    channel: "stable",
    inputs: [source],
  };

  const stamp = path.join(root, "cache.json");
  const original = iconCacheKey(options);
  assert.equal(readIconCache(stamp), undefined);
  writeIconCache(stamp, original);
  assert.equal(readIconCache(stamp), iconCacheKey(options));
  assert.notEqual(iconCacheKey({ ...options, channel: "preview" }), original);
  assert.notEqual(iconCacheKey({ ...options, iconName: "custom" }), original);

  for (const file of [
    source,
    path.join(resources, "Assets.car"),
    path.join(resources, "Review.icns"),
  ]) {
    const before = iconCacheKey(options);
    writeFileSync(file, "changed");
    assert.notEqual(iconCacheKey(options), before);
  }

  let before = iconCacheKey(options);
  rmSync(path.join(resources, "Assets.car"));
  assert.notEqual(iconCacheKey(options), before);
  before = iconCacheKey(options);
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), "changed plist");
  assert.notEqual(iconCacheKey(options), before);
  before = iconCacheKey(options);
  renameSync(executable, executable + ".old");
  writeFileSync(executable, "electron");
  rmSync(executable + ".old");
  assert.notEqual(iconCacheKey(options), before);
  writeFileSync(stamp, "partial write");
  assert.equal(readIconCache(stamp), undefined);
});
