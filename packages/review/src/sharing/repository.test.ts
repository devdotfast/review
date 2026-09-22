import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  fetchPinnedRepository,
  repositoryReady,
  sharedGit,
} from "./repository.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function remoteFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-git-"));
  directories.push(root);

  const sender = path.join(root, "sender"),
    remote = path.join(root, "remote.git");

  await mkdir(sender);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: sender,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(sender, "answer.ts"), "export const answer = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(sender, "answer.ts"), "export const answer = 2;\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  git("clone", "--bare", sender, remote);

  return { root, sender, remote, git, pins: { base, head } };
}

it("fetches both pinned histories independently and reads them after the sender and remote disappear", async () => {
  const { root, sender, remote, pins } = await remoteFixture();
  const checkout = path.join(root, "recipient");
  vi.stubEnv("GIT_DIR", path.join(root, "nonexistent.git"));
  vi.stubEnv(
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    path.join(sender, ".git", "objects"),
  );
  await fetchPinnedRepository(checkout, remote, pins);
  await sharedGit(checkout, ["checkout", "--detach", pins.head]);
  await rename(sender, sender + "-hidden");
  await rename(remote, remote + "-hidden");
  expect(await repositoryReady(checkout, pins)).toBe(true);
  expect(
    (await sharedGit(checkout, ["show", `${pins.base}:answer.ts`])).stdout,
  ).toContain("answer = 1");
  expect(
    (await sharedGit(checkout, ["show", `${pins.head}:answer.ts`])).stdout,
  ).toContain("answer = 2");
  expect(
    (await sharedGit(checkout, ["diff", pins.base, pins.head])).stdout,
  ).toContain("+export const answer = 2");
  await rm(checkout, { recursive: true });
  expect(await repositoryReady(checkout, pins)).toBe(false);
});

it("rejects an unpushed commit even when the sender has its objects", async () => {
  const { root, remote, git, pins } = await remoteFixture();
  git("commit", "--allow-empty", "-qm", "not pushed");
  const head = git("rev-parse", "HEAD");
  await expect(
    fetchPinnedRepository(
      path.join(root, "recipient"),
      remote,
      { ...pins, head },
      true,
    ),
  ).rejects.toThrow("Push the reviewed commits to GitHub before sharing.");
});

it("checks published pins without downloading trees, blobs, or intervening history", async () => {
  const { root, remote, git, pins } = await remoteFixture();
  git("commit", "--allow-empty", "-qm", "third commit");
  const head = git("rev-parse", "HEAD");
  git("push", remote, "HEAD:refs/heads/published");
  execFileSync("git", [
    "-C",
    remote,
    "config",
    "uploadpack.allowFilter",
    "true",
  ]);
  const checkout = path.join(root, "preflight");

  await fetchPinnedRepository(
    checkout,
    `file://${remote}`,
    { ...pins, head },
    true,
  );

  const objects = await sharedGit(checkout, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ]);

  expect(objects.stdout.trim().split("\n").sort()).toEqual(
    [`${pins.base} commit`, `${head} commit`].sort(),
  );
});

it("reports access and connection failures without leaking Git output", async () => {
  const { root, pins } = await remoteFixture();
  await expect(
    fetchPinnedRepository(
      path.join(root, "recipient"),
      path.join(root, "missing-private.git"),
      pins,
    ),
  ).rejects.toThrow("Check your connection and Git credentials");
});

it("rejects non-commit pins during publication", async () => {
  const { root, remote, git, pins } = await remoteFixture();

  for (const [kind, spec] of [
    ["tree", "HEAD^{tree}"],
    ["blob", "HEAD:answer.ts"],
  ]) {
    const head = git("rev-parse", spec!);
    await expect(
      fetchPinnedRepository(
        path.join(root, kind!),
        remote,
        { ...pins, head },
        true,
      ),
    ).rejects.toThrow("Could not fetch the GitHub repository.");
  }
});
