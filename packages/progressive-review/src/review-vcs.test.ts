import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reviewVcs } from "./review-vcs";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-vcs-"));
  tempRoots.push(dir);
  return dir;
}

describe("reviewVcs seal", () => {
  it("excludes gitignored files from sealed revisions", async () => {
    // Regression: seals once captured review.db and stale .build/ copies,
    // re-embedding every previous materialization into each new revision.
    const root = await tempDir();
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(
      path.join(dir, ".gitignore"),
      ".build/\nreview.db\nreview.db-wal\nreview.db-shm\n",
    );
    await writeFile(path.join(dir, "review.mdx"), "# Review\n");
    await writeFile(path.join(dir, "review.db"), "binary");
    await mkdir(path.join(dir, ".build"), { recursive: true });
    await writeFile(path.join(dir, ".build", "stale"), "stale");

    const revision = await reviewVcs.seal(dir, "checkpoint");
    const out = path.join(root, "sealed");
    await reviewVcs.materialize(dir, revision, out);

    await expect(readFile(path.join(out, "review.mdx"), "utf8")).resolves.toBe(
      "# Review\n",
    );
    expect(existsSync(path.join(out, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(out, "review.db"))).toBe(false);
    expect(existsSync(path.join(out, ".build"))).toBe(false);
  });
});

describe("reviewVcs log", () => {
  it("returns sealed commits newest first and [] before the first seal", async () => {
    const root = await tempDir();
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await expect(reviewVcs.log(dir)).resolves.toEqual([]);
    await writeFile(path.join(dir, "review.mdx"), "# One\n");
    const first = await reviewVcs.seal(dir, "Review publish candidate");
    await writeFile(path.join(dir, "review.mdx"), "# Two\n");
    const second = await reviewVcs.seal(dir, "Publish Review software map");

    const entries = await reviewVcs.log(dir);

    expect(entries.map((entry) => entry.oid)).toEqual([second, first]);
    expect(entries[0]?.message).toBe("Publish Review software map");
    expect(entries[1]?.message).toBe("Review publish candidate");
    expect(entries[0]?.timestamp).toBeGreaterThan(0);
  });
});

describe("reviewVcs materialize (atomic)", () => {
  it("leaves no staging directory behind after a successful materialization", async () => {
    const root = await tempDir();
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(path.join(dir, ".gitignore"), ".build/\n");
    await writeFile(path.join(dir, "review.mdx"), "# Review\n");
    const revision = await reviewVcs.seal(dir, "checkpoint");

    const out = path.join(root, "sealed");
    await reviewVcs.materialize(dir, revision, out);

    await expect(readFile(path.join(out, "review.mdx"), "utf8")).resolves.toBe(
      "# Review\n",
    );
    // The staging directory is renamed into place, so no sibling partial tree
    // remains for the caller (or a cache check) to mistake for a build.
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it("replaces an existing complete destination without leaving a staging directory", async () => {
    const root = await tempDir();
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(path.join(dir, ".gitignore"), ".build/\n");
    await writeFile(path.join(dir, "review.mdx"), "# One\n");
    const first = await reviewVcs.seal(dir, "first");

    const out = path.join(root, "sealed");
    await reviewVcs.materialize(dir, first, out);
    await expect(readFile(path.join(out, "review.mdx"), "utf8")).resolves.toBe(
      "# One\n",
    );

    // Seal a second revision and re-materialize over the existing build dir.
    await writeFile(path.join(dir, "review.mdx"), "# Two\n");
    const second = await reviewVcs.seal(dir, "second");
    await reviewVcs.materialize(dir, second, out);

    await expect(readFile(path.join(out, "review.mdx"), "utf8")).resolves.toBe(
      "# Two\n",
    );
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it("leaves no destination or staging tree when a mid-walk blob read fails, then rebuilds", async () => {
    // Removing a single loose git object makes `git.walk`'s `entry.content()`
    // reject mid-walk (a faithful, mock-free model of an interrupted write).
    const root = await tempDir();
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    await writeFile(path.join(dir, ".gitignore"), ".build/\n");
    await writeFile(path.join(dir, "review.mdx"), "# Review\n");
    const target = '{"presentedSoftwareMapRevision":null}\n';
    await writeFile(path.join(dir, "review.json"), target);
    const revision = await reviewVcs.seal(dir, "checkpoint");

    const header = Buffer.from(`blob ${target.length}\0`);
    const oid = createHash("sha1")
      .update(Buffer.concat([header, Buffer.from(target)]))
      .digest("hex");
    const objectPath = path.join(
      dir,
      ".git",
      "objects",
      oid.slice(0, 2),
      oid.slice(2),
    );
    expect(existsSync(objectPath)).toBe(true);
    const savedObject = await readFile(objectPath);

    const out = path.join(root, "sealed");
    await rm(objectPath, { force: true });

    // The mid-walk failure must reject without ever creating `out` (the cache
    // key) or leaving an orphaned `.partial` staging tree behind.
    await expect(reviewVcs.materialize(dir, revision, out)).rejects.toThrow(
      /Could not find/,
    );
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);

    // Once the blob is restored, the same revision materializes in full.
    await writeFile(objectPath, savedObject);
    await reviewVcs.materialize(dir, revision, out);
    await expect(readFile(path.join(out, "review.json"), "utf8")).resolves.toBe(
      target,
    );
    expect(existsSync(`${out}.partial`)).toBe(false);
  });
});
