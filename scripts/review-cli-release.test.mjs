import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  alreadyPublished,
  createTag,
  nextVersion,
  parseVersion,
  registryMetadata,
  resolveRelease,
} from "./review-cli-release.mjs";

const metadata = {
  versions: { "0.2.9": {}, "0.2.10": {}, "1.0.0-preview.1": {} },
};

const send = async () => Response.json(metadata);

test("bumps the highest stable version numerically and resets lower components", () => {
  const versions = ["0.0.1", ...Object.keys(metadata.versions)];
  assert.equal(nextVersion(versions, "patch"), "0.2.11");
  assert.equal(nextVersion(versions, "minor"), "0.3.0");
  assert.equal(nextVersion(versions, "major"), "1.0.0");
  assert.equal(nextVersion([...versions, "0.2.11"], "patch"), "0.2.12");

  for (const version of [
    "01.2.3",
    "1.2",
    "v1.2.3",
    "1.2.3-preview.1",
    "1.2.3; echo nope",
  ])
    assert.throws(() => parseVersion(version));
  assert.throws(() => nextVersion(versions, "bogus"));
});

test("registry errors stop planning; only a package 404 means no versions", async () => {
  assert.deepEqual(
    await registryMetadata(async () => new Response(null, { status: 404 })),
    { versions: {} },
  );
  await assert.rejects(
    registryMetadata(async () => new Response(null, { status: 503 })),
    /refusing to guess/,
  );
  await assert.rejects(
    registryMetadata(async () => Response.json({})),
    /Invalid npm/,
  );
});

test("published versions are accepted only for the exact source commit", () => {
  const existing = { versions: { "0.2.11": { gitHead: "abc" } } };
  assert.equal(alreadyPublished(existing, "0.2.11", "abc"), true);
  assert.equal(alreadyPublished(existing, "0.2.12", "abc"), false);
  assert.throws(
    () => alreadyPublished(existing, "0.2.11", "def"),
    /already exists/,
  );
  assert.throws(
    () => alreadyPublished(metadata, "0.2.10", "abc"),
    /unknown commit/,
  );
});

function repository(t) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "review-cli-release-test-"),
  );

  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  });

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  mkdirSync(path.join(directory, "packages/review"), { recursive: true });
  writeFileSync(
    path.join(directory, "packages/review/package.json"),
    '{"version":"0.0.1"}\n',
  );
  git("add", ".");
  git("commit", "-qm", "initial");
  git("init", "-q", "--bare", "origin.git");
  git("remote", "add", "origin", path.join(directory, "origin.git"));
  git("push", "-qu", "origin", "main");
  process.chdir(directory);

  return {
    git,
    env: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "123",
      RELEASE_BUMP: "patch",
    },
  };
}

test("dispatch plans without mutations, reserves an annotated tag, and retries the same version", async (t) => {
  const { git, env } = repository(t);
  const plan = await resolveRelease(env, send);
  assert.equal(plan.version, "0.2.11");
  assert.equal(git("tag", "--list"), "");
  assert.equal(
    JSON.parse(readFileSync("packages/review/package.json", "utf8")).version,
    "0.0.1",
  );
  createTag(plan);
  assert.equal(git("rev-parse", `${plan.tag}^{commit}`), plan.commit);
  assert.equal((await resolveRelease(env, send)).version, plan.version);
  createTag(plan); // Existing same-commit tag is idempotent.
  assert.equal(
    (await resolveRelease({ ...env, GITHUB_RUN_ID: "124" }, send)).version,
    "0.2.12",
  );
});

test("tag push selects that exact version, rejects rollback, and detects npm collisions", async (t) => {
  const { git, env } = repository(t);
  git("tag", "whiteboard-v0.3.0");

  const push = {
    ...env,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_NAME: "whiteboard-v0.3.0",
  };

  assert.equal((await resolveRelease(push, send)).version, "0.3.0");
  await assert.rejects(
    resolveRelease({ ...push, GITHUB_REF_NAME: "whiteboard-v0.2.8" }, send),
    /newer/,
  );
  await assert.rejects(
    resolveRelease({ ...push, GITHUB_REF_NAME: "whiteboard-v0.2.10" }, send),
    /already exists/,
  );
  const commit = git("rev-parse", "HEAD");

  const published = async () =>
    Response.json({ versions: { "0.3.0": { gitHead: commit } } });

  assert.equal((await resolveRelease(push, published)).published, true);
});

test("refuses non-main dispatches and commits that never landed on main", async (t) => {
  const { git, env } = repository(t);
  await assert.rejects(
    resolveRelease({ ...env, GITHUB_REF: "refs/heads/feature" }, send),
    /from main/,
  );
  git("checkout", "-qb", "feature");
  writeFileSync("unmerged", "change");
  git("add", "unmerged");
  git("commit", "-qm", "unmerged");
  await assert.rejects(resolveRelease(env, send));
});

test("tag reservation refuses to move another release's tag", async (t) => {
  const { git, env } = repository(t);
  const plan = await resolveRelease(env, send);
  git("commit", "--allow-empty", "-qm", "later");
  git("tag", plan.tag);
  git("push", "origin", plan.tag);
  assert.throws(() => createTag(plan), /different commit/);
});
