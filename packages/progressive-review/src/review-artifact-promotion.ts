import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ReviewRecord } from "@dev.fast/review-protocol";

import { isMissingFileError } from "./native-agent/transcript-json";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

export async function promoteReviewArtifactFiles(input: {
  reviewDir: string;
  candidateDir: string;
  record: ReviewRecord;
  upgradeThreadDatabase?: boolean;
}): Promise<void> {
  const staging = await mkdtemp(
    path.join(
      path.dirname(input.reviewDir),
      `.${path.basename(input.reviewDir)}-promotion-`,
    ),
  );
  const prepared = path.join(staging, "prepared");
  const backup = path.join(staging, "backup");
  try {
    await mkdir(prepared);
    await mkdir(backup);
    for (const name of [".bundle", ".git"]) {
      await cp(path.join(input.candidateDir, name), path.join(prepared, name), {
        recursive: true,
      });
    }
    if (input.upgradeThreadDatabase)
      await cp(
        path.join(input.candidateDir, "review.db"),
        path.join(prepared, "review.db"),
      );
    await writePrivateJsonAtomic(
      path.join(prepared, "review.json"),
      input.record,
    );
    await cp(
      path.join(input.reviewDir, "review.json"),
      path.join(backup, "review.json"),
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await commitReviewArtifactPromotion({
    reviewDir: input.reviewDir,
    stagingDir: staging,
    upgradeThreadDatabase: input.upgradeThreadDatabase,
  });
}

export async function commitReviewArtifactPromotion(input: {
  reviewDir: string;
  stagingDir: string;
  upgradeThreadDatabase?: boolean;
}): Promise<void> {
  const prepared = path.join(input.stagingDir, "prepared");
  const backup = path.join(input.stagingDir, "backup");
  const replacements: Array<{ name: string; hadOriginal: boolean }> = [];
  const replacementNames = [".bundle", ".git"];
  if (input.upgradeThreadDatabase)
    replacementNames.push("review.db", "review.db-wal", "review.db-shm");
  try {
    for (const name of replacementNames) {
      let hadOriginal = true;
      try {
        await rename(path.join(input.reviewDir, name), path.join(backup, name));
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        hadOriginal = false;
      }
      replacements.push({ name, hadOriginal });
      // The upgraded database is checkpointed; retire its old WAL/SHM
      // together with the database and restore all three on failure.
      if (name !== "review.db-wal" && name !== "review.db-shm")
        await rename(
          path.join(prepared, name),
          path.join(input.reviewDir, name),
        );
    }
    await rename(
      path.join(prepared, "review.json"),
      path.join(input.reviewDir, "review.json"),
    );
  } catch (error) {
    await rollbackReviewArtifactPromotion({
      reviewDir: input.reviewDir,
      stagingDir: input.stagingDir,
      replacements,
      error,
    });
  }
  await rm(input.stagingDir, { recursive: true, force: true });
}

export async function rollbackReviewArtifactPromotion(input: {
  reviewDir: string;
  stagingDir: string;
  replacements: Array<{ name: string; hadOriginal: boolean }>;
  error: unknown;
}): Promise<never> {
  const backup = path.join(input.stagingDir, "backup");
  try {
    for (const { name, hadOriginal } of input.replacements.reverse()) {
      await rm(path.join(input.reviewDir, name), {
        recursive: true,
        force: true,
      });
      if (hadOriginal) {
        await rename(path.join(backup, name), path.join(input.reviewDir, name));
      }
    }
  } catch (rollbackError) {
    throw new AggregateError(
      [input.error, rollbackError],
      `Review rollback could not complete. Original review files remain in ${input.reviewDir} and ${backup}.`,
    );
  }
  await rm(input.stagingDir, { recursive: true, force: true });
  throw input.error;
}
