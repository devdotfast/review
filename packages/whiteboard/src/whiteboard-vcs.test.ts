import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "./whiteboard-test-utils";
import { whiteboardVcs } from "./whiteboard-vcs";

afterEach(cleanupTempDirs);

describe("whiteboardVcs seal", () => {
  it("excludes gitignored files from sealed revisions", async () => {
    // Regression: seals once captured review.db and stale .build/ copies,
    // re-embedding every previous materialization into each new revision.
    const root = await tempDir("review-vcs-");
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await whiteboardVcs.init(dir);
    await writeFile(
      path.join(dir, ".gitignore"),
      ".build/\nreview.db\nreview.db-wal\nreview.db-shm\n",
    );
    await writeFile(path.join(dir, "review.mdx"), "# Review\n");
    await writeFile(path.join(dir, "review.db"), "binary");
    await mkdir(path.join(dir, ".build"), { recursive: true });
    await writeFile(path.join(dir, ".build", "stale"), "stale");

    const revision = await whiteboardVcs.seal(dir, "checkpoint");
    const out = path.join(root, "sealed");
    await whiteboardVcs.materialize(dir, revision, out);

    await expect(readFile(path.join(out, "review.mdx"), "utf8")).resolves.toBe(
      "# Review\n",
    );
    expect(existsSync(path.join(out, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(out, "review.db"))).toBe(false);
    expect(existsSync(path.join(out, ".build"))).toBe(false);
  });
});

describe("whiteboardVcs log", () => {
  it("returns sealed commits newest first and [] before the first seal", async () => {
    const root = await tempDir("review-vcs-");
    const dir = path.join(root, "review");
    await mkdir(dir, { recursive: true });
    await whiteboardVcs.init(dir);
    await expect(whiteboardVcs.log(dir)).resolves.toEqual([]);
    await writeFile(path.join(dir, "review.mdx"), "# One\n");
    const first = await whiteboardVcs.seal(dir, "Review publish candidate");
    await writeFile(path.join(dir, "review.mdx"), "# Two\n");
    const second = await whiteboardVcs.seal(dir, "Publish Review software map");

    const entries = await whiteboardVcs.log(dir);

    expect(entries.map((entry) => entry.oid)).toEqual([second, first]);
    expect(entries[0]?.message).toBe("Publish Review software map");
    expect(entries[1]?.message).toBe("Review publish candidate");
    expect(entries[0]?.timestamp).toBeGreaterThan(0);
  });
});
