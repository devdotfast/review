import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { promoteReviewArtifactFiles } from "./review-artifact-promotion";
import { parseStoredReviewRecord } from "./review-home";
import { cleanupTempDirs, storedReviewFixture } from "./review-test-utils";

let root: string;

afterEach(cleanupTempDirs);

async function fixture() {
  const staged = await storedReviewFixture();
  const reviewDir = staged.reviewDir;
  root = path.dirname(reviewDir);
  const candidateDir = path.join(root, "candidate");
  await cp(reviewDir, candidateDir, { recursive: true });
  await writeFile(path.join(candidateDir, ".git", "HEAD"), "new-head");
  await writeFile(
    path.join(candidateDir, ".bundle", "document"),
    "new-document",
  );

  return {
    reviewDir,
    candidateDir,
    record: {
      ...parseStoredReviewRecord(staged.record),
      presentedDocumentRevision: "d".repeat(40),
    },
  };
}

it("stages every replacement before touching live files", async () => {
  const input = await fixture();
  await rm(path.join(input.candidateDir, ".git"), { recursive: true });
  const originalInode = (await stat(path.join(input.reviewDir, ".git"))).ino;
  await expect(promoteReviewArtifactFiles(input)).rejects.toThrow("ENOENT");
  expect((await stat(path.join(input.reviewDir, ".git"))).ino).toBe(
    originalInode,
  );
  expect(
    await readFile(path.join(input.reviewDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("promotes fully prepared files and removes temporary state", async () => {
  const input = await fixture();
  await promoteReviewArtifactFiles(input);
  expect(
    await readFile(path.join(input.reviewDir, ".git", "HEAD"), "utf8"),
  ).toBe("new-head");
  expect(
    await readFile(path.join(input.reviewDir, ".bundle", "document"), "utf8"),
  ).toBe("new-document");
  expect(
    JSON.parse(
      await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
    ),
  ).toEqual(input.record);
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});
