import { existsSync } from "node:fs";
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
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  commitReviewArtifactPromotion,
  promoteReviewArtifactFiles,
  rollbackReviewArtifactPromotion,
} from "./review-artifact-promotion";
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

it("restores original directories by rename after replacement failure", async () => {
  const input = await fixture();
  const originalInode = (await stat(path.join(input.reviewDir, ".git"))).ino;

  const originalRecord = await readFile(
    path.join(input.reviewDir, "review.json"),
    "utf8",
  );

  const { stagingDir, prepared } = await preparedCommitFixture(input);
  await expect(
    commitReviewArtifactPromotion({
      reviewDir: input.reviewDir,
      stagingDir,
    }),
  ).rejects.toMatchObject({
    code: "ENOENT",
    syscall: "rename",
    path: path.join(prepared, "review.json"),
  });
  expect((await stat(path.join(input.reviewDir, ".git"))).ino).toBe(
    originalInode,
  );
  expect(
    await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
  ).toBe(originalRecord);
  expect(
    await readFile(path.join(input.reviewDir, ".bundle", "document"), "utf8"),
  ).toBe("old-document");
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("retains remaining backups when an original artifact is missing during rollback", async () => {
  const input = await fixture();
  const stagingDir = await mkdtemp(path.join(root, ".review-promotion-"));
  const backup = path.join(stagingDir, "backup");
  await mkdir(backup);
  await rename(
    path.join(input.reviewDir, ".bundle"),
    path.join(backup, ".bundle"),
  );
  await mkdir(path.join(input.reviewDir, ".bundle"));
  await writeFile(path.join(input.reviewDir, ".bundle", "document"), "new");
  await cp(
    path.join(input.reviewDir, "review.json"),
    path.join(backup, "review.json"),
  );
  const failure = new Error("promotion failed");

  await expect(
    rollbackReviewArtifactPromotion({
      reviewDir: input.reviewDir,
      stagingDir,
      replacements: [
        { name: ".bundle", hadOriginal: true },
        { name: ".git", hadOriginal: true },
      ],
      error: failure,
    }),
  ).rejects.toMatchObject({
    errors: [
      failure,
      {
        code: "ENOENT",
        syscall: "rename",
        path: path.join(backup, ".git"),
      },
    ],
  });
  expect(existsSync(stagingDir)).toBe(true);
  expect(await readFile(path.join(backup, ".bundle", "document"), "utf8")).toBe(
    "old-document",
  );
  expect(
    JSON.parse(await readFile(path.join(backup, "review.json"), "utf8"))
      .presentedDocumentRevision,
  ).toBe("c".repeat(40));
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

async function preparedCommitFixture(
  input: Awaited<ReturnType<typeof fixture>>,
) {
  const stagingDir = await mkdtemp(path.join(root, ".review-promotion-"));
  const prepared = path.join(stagingDir, "prepared");
  const backup = path.join(stagingDir, "backup");
  await mkdir(prepared);
  await mkdir(backup);

  for (const name of [".bundle", ".git"])
    await cp(path.join(input.candidateDir, name), path.join(prepared, name), {
      recursive: true,
    });
  await cp(
    path.join(input.reviewDir, "review.json"),
    path.join(backup, "review.json"),
  );

  return { stagingDir, prepared };
}
