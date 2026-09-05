import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { promoteReviewArtifactFiles } from "./review-artifact-promotion";
import { parseStoredReviewRecord } from "./review-home";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), "artifact-promotion-"));
  const reviewDir = path.join(root, "review");
  const candidateDir = path.join(root, "candidate");
  await mkdir(path.join(reviewDir, ".git"), { recursive: true });
  await mkdir(path.join(reviewDir, ".bundle"));
  const record = parseStoredReviewRecord({
    schemaVersion: 5,
    uuid: "11111111-1111-4111-8111-111111111111",
    repoKey: "repo",
    worktreePath: "/source",
    baseRef: "main",
    baseCommit: "a".repeat(40),
    sourceCommit: "b".repeat(40),
    sourceIdentity: null,
    title: "Preserve",
    sourceSession: "disabled:review",
    status: "accepted",
    presentedDocumentRevision: "c".repeat(40),
    presentedSoftwareMapRevision: null,
    createdAt: "created",
    lastPublishedAt: "published",
  });
  await writeFile(path.join(reviewDir, "review.json"), JSON.stringify(record));
  await writeFile(path.join(reviewDir, ".git", "HEAD"), "old-head");
  await writeFile(path.join(reviewDir, ".bundle", "document"), "old-document");
  await cp(reviewDir, candidateDir, { recursive: true });
  await writeFile(path.join(candidateDir, ".git", "HEAD"), "new-head");
  await writeFile(
    path.join(candidateDir, ".bundle", "document"),
    "new-document",
  );
  return {
    reviewDir,
    candidateDir,
    record: { ...record, presentedDocumentRevision: "d".repeat(40) },
  };
}

it("stages every replacement before touching live files", async () => {
  const input = await fixture();
  const originalInode = (await stat(path.join(input.reviewDir, ".git"))).ino;
  await expect(
    promoteReviewArtifactFiles({
      ...input,
      writeRecord: async () => {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow("disk full");
  expect((await stat(path.join(input.reviewDir, ".git"))).ino).toBe(
    originalInode,
  );
  expect(
    await readFile(path.join(input.reviewDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("restores original directories by rename after replacement failure", async () => {
  const input = await fixture();
  const originalInode = (await stat(path.join(input.reviewDir, ".git"))).ino;
  const originalRecord = await readFile(
    path.join(input.reviewDir, "review.json"),
    "utf8",
  );
  await expect(
    promoteReviewArtifactFiles({
      ...input,
      renamePath: async (source, target) => {
        if (String(source).endsWith("prepared/review.json"))
          throw new Error("promotion failed");
        return rename(source, target);
      },
    }),
  ).rejects.toThrow("promotion failed");
  expect((await stat(path.join(input.reviewDir, ".git"))).ino).toBe(
    originalInode,
  );
  expect(
    await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
  ).toBe(originalRecord);
  expect(
    await readFile(path.join(input.reviewDir, ".bundle", "document"), "utf8"),
  ).toBe("old-document");
});

it("retains original history and reports the backup if restoration fails", async () => {
  const input = await fixture();
  await expect(
    promoteReviewArtifactFiles({
      ...input,
      renamePath: async (source, target) => {
        if (String(source).endsWith("prepared/review.json"))
          throw new Error("promotion failed");
        if (String(source).includes("/backup/"))
          throw new Error("restoration failed");
        return rename(source, target);
      },
    }),
  ).rejects.toThrow("Original review files remain");
  const backups = (await readdir(root)).filter((name) =>
    name.startsWith(".review-promotion-"),
  );
  expect(backups).toHaveLength(1);
  expect(
    await readFile(
      path.join(root, backups[0], "backup", ".git", "HEAD"),
      "utf8",
    ),
  ).toBe("old-head");
  expect(
    await readFile(
      path.join(root, backups[0], "backup", ".bundle", "document"),
      "utf8",
    ),
  ).toBe("old-document");
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
