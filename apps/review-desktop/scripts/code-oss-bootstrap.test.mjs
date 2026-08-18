import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dependencyDirectoriesExist,
  lockfileDigest,
  needsDependencyInstall,
} from "./code-oss-bootstrap.mjs";

const bootstrapScript = fileURLToPath(
  new URL("./code-oss-bootstrap.mjs", import.meta.url),
);

function matchingDependencies() {
  return {
    dependencyDirectoriesExist: true,
    installedLockfileDigest: "current-inputs",
    lockfileDigest: "current-inputs",
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "review-desktop-"));
  const installDirs = ["", "extensions/git"];
  await mkdir(path.join(directory, "node_modules"));
  await mkdir(path.join(directory, "extensions", "git", "node_modules"), {
    recursive: true,
  });
  await writeFile(path.join(directory, ".nvmrc"), "24.18.0");
  await writeFile(path.join(directory, "package.json"), '{"name":"root"}');
  await writeFile(path.join(directory, "package-lock.json"), "root lockfile");
  await writeFile(
    path.join(directory, "extensions", "git", "package.json"),
    '{"name":"git"}',
  );
  await writeFile(
    path.join(directory, "extensions", "git", "package-lock.json"),
    "nested lockfile",
  );
  await writeFile(
    path.join(directory, "extensions", "git", ".npmrc"),
    "ignore-scripts=true",
  );
  return { directory, installDirs };
}

test("installs Code OSS dependencies for a clean checkout", () => {
  assert.equal(
    needsDependencyInstall({
      ...matchingDependencies(),
      dependencyDirectoriesExist: false,
      installedLockfileDigest: undefined,
    }),
    true,
  );
});

test("installs when the installed dependencies do not match the inputs", () => {
  assert.equal(
    needsDependencyInstall({
      ...matchingDependencies(),
      installedLockfileDigest: "old-inputs",
    }),
    true,
  );
});

test("installs when any nested Code OSS dependency directory is missing", async () => {
  const { directory, installDirs } = await fixture();
  assert.equal(dependencyDirectoriesExist(directory, installDirs), true);

  const missingDirectory = await mkdtemp(
    path.join(tmpdir(), "review-desktop-"),
  );
  await mkdir(path.join(missingDirectory, "node_modules"));
  assert.equal(
    dependencyDirectoriesExist(missingDirectory, installDirs),
    false,
  );
});

test("keeps matching Code OSS dependencies for repeat launches", () => {
  assert.equal(needsDependencyInstall(matchingDependencies()), false);
});

test("the bootstrap digest includes every upstream install input", async () => {
  const { directory, installDirs } = await fixture();
  const digest = () => lockfileDigest(directory, installDirs);

  const originalDigest = await digest();
  await writeFile(
    path.join(directory, "extensions", "git", ".npmrc"),
    "ignore-scripts=false",
  );
  assert.notEqual(await digest(), originalDigest);

  const npmrcDigest = await digest();
  await writeFile(path.join(directory, "package.json"), '{"name":"changed"}');
  assert.notEqual(await digest(), npmrcDigest);

  const packageDigest = await digest();
  await writeFile(path.join(directory, ".nvmrc"), "24.19.0");
  assert.notEqual(await digest(), packageDigest);
});

test("the bootstrap digest ignores lockfiles outside upstream install directories", async () => {
  const { directory, installDirs } = await fixture();
  const originalDigest = await lockfileDigest(directory, installDirs);
  const unusedLockfile = path.join(
    directory,
    "test",
    "smoke",
    "package-lock.json",
  );
  await mkdir(path.dirname(unusedLockfile), { recursive: true });
  await writeFile(unusedLockfile, "unused lockfile");

  assert.equal(await lockfileDigest(directory, installDirs), originalDigest);
});

test("the bootstrap command runs through a symlinked script path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-desktop-"));
  const linkedScript = path.join(directory, "code-oss-bootstrap.mjs");
  await symlink(bootstrapScript, linkedScript);
  await writeFile(path.join(directory, "package-lock.json"), "lockfile");

  const digest = execFileSync(
    process.execPath,
    [linkedScript, "digest", directory],
    { encoding: "utf8" },
  ).trim();

  assert.match(digest, /^[a-f0-9]{64}$/);
});
