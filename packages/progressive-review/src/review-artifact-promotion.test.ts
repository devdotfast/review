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
  commitLegacyThreadDatabasePromotion,
  promoteLegacyThreadDatabase,
  rollbackLegacyThreadDatabasePromotion,
} from "./review-artifact-promotion";
import { cleanupTempDirs, storedReviewFixture } from "./review-test-utils";

const DATABASE_FILES = ["review.db", "review.db-wal", "review.db-shm"];

let root: string;

afterEach(cleanupTempDirs);

async function fixture() {
  const staged = await storedReviewFixture();
  const reviewDir = staged.reviewDir;
  root = path.dirname(reviewDir);
  const candidateDir = path.join(root, "candidate");
  await mkdir(candidateDir);
  for (const name of DATABASE_FILES)
    await writeFile(path.join(reviewDir, name), `original ${name}`);
  await writeFile(path.join(candidateDir, "review.db"), "upgraded database");
  return { reviewDir, candidateDir };
}

/** The prepared/backup layout `promoteLegacyThreadDatabase` builds, so a test
 * can commit or roll back a half-built one. */
async function preparedCommitFixture(
  input: Awaited<ReturnType<typeof fixture>>,
  options: { omit?: string } = {},
) {
  const stagingDir = await mkdtemp(path.join(root, ".review-promotion-"));
  const prepared = path.join(stagingDir, "prepared");
  await mkdir(prepared);
  await mkdir(path.join(stagingDir, "backup"));
  if (options.omit !== "review.db")
    await cp(
      path.join(input.candidateDir, "review.db"),
      path.join(prepared, "review.db"),
    );
  return { stagingDir, prepared };
}

it("stages the upgraded database before touching live files", async () => {
  const input = await fixture();
  await rm(path.join(input.candidateDir, "review.db"));
  const originalInode = (await stat(path.join(input.reviewDir, "review.db")))
    .ino;
  await expect(promoteLegacyThreadDatabase(input)).rejects.toThrow("ENOENT");
  expect((await stat(path.join(input.reviewDir, "review.db"))).ino).toBe(
    originalInode,
  );
  expect(await readFile(path.join(input.reviewDir, "review.db"), "utf8")).toBe(
    "original review.db",
  );
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("rolls back the database and its sidecars after promotion failure", async () => {
  const input = await fixture();
  const { stagingDir, prepared } = await preparedCommitFixture(input, {
    omit: "review.db",
  });
  const originalInodes = new Map(
    await Promise.all(
      DATABASE_FILES.map(
        async (name) =>
          [name, (await stat(path.join(input.reviewDir, name))).ino] as const,
      ),
    ),
  );
  const originalRecord = await readFile(
    path.join(input.reviewDir, "review.json"),
    "utf8",
  );

  await expect(
    commitLegacyThreadDatabasePromotion({
      reviewDir: input.reviewDir,
      stagingDir,
    }),
  ).rejects.toMatchObject({
    code: "ENOENT",
    syscall: "rename",
    path: path.join(prepared, "review.db"),
  });

  for (const name of DATABASE_FILES) {
    expect(await readFile(path.join(input.reviewDir, name), "utf8")).toBe(
      `original ${name}`,
    );
    expect((await stat(path.join(input.reviewDir, name))).ino).toBe(
      originalInodes.get(name),
    );
  }
  expect(
    await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
  ).toBe(originalRecord);
  expect(existsSync(stagingDir)).toBe(false);
});

it("retains remaining backups when an original file is missing during rollback", async () => {
  const input = await fixture();
  const stagingDir = await mkdtemp(path.join(root, ".review-promotion-"));
  const backup = path.join(stagingDir, "backup");
  await mkdir(backup);
  await rename(
    path.join(input.reviewDir, "review.db"),
    path.join(backup, "review.db"),
  );
  await writeFile(path.join(input.reviewDir, "review.db"), "half-promoted");
  const failure = new Error("promotion failed");

  await expect(
    rollbackLegacyThreadDatabasePromotion({
      reviewDir: input.reviewDir,
      stagingDir,
      replacements: [
        { name: "review.db", hadOriginal: true },
        { name: "review.db-wal", hadOriginal: true },
      ],
      error: failure,
    }),
  ).rejects.toMatchObject({
    errors: [
      failure,
      {
        code: "ENOENT",
        syscall: "rename",
        path: path.join(backup, "review.db-wal"),
      },
    ],
  });
  expect(existsSync(stagingDir)).toBe(true);
  expect(await readFile(path.join(backup, "review.db"), "utf8")).toBe(
    "original review.db",
  );
});

it("promotes the checkpointed database and retires original sidecars", async () => {
  const input = await fixture();
  const originalRecord = await readFile(
    path.join(input.reviewDir, "review.json"),
    "utf8",
  );
  await promoteLegacyThreadDatabase(input);
  expect(await readFile(path.join(input.reviewDir, "review.db"), "utf8")).toBe(
    "upgraded database",
  );
  const entries = await readdir(input.reviewDir);
  expect(entries).not.toContain("review.db-wal");
  expect(entries).not.toContain("review.db-shm");
  // review.json is a mirror this function never writes; the caller persists
  // the new record to the database and refreshes the mirror.
  expect(
    await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
  ).toBe(originalRecord);
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});
