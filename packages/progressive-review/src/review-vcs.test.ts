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
