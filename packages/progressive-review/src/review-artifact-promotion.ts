import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ReviewRecord } from "@dev.fast/review-protocol";

import { isMissingFileError } from "./native-agent/transcript-json";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

export async function promoteReviewArtifactFiles(input: {
  reviewDir: string;
  candidateDir: string;
  record: ReviewRecord;
  writeRecord?: typeof writePrivateJsonAtomic;
  renamePath?: typeof rename;
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
  const renamePath = input.renamePath ?? rename;
  const replacements: Array<{ name: string; hadOriginal: boolean }> = [];
  let retainBackup = false;
  const replacementNames = [".bundle", ".git"];
  if (input.upgradeThreadDatabase)
    replacementNames.push("review.db", "review.db-wal", "review.db-shm");
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
    await (input.writeRecord ?? writePrivateJsonAtomic)(
      path.join(prepared, "review.json"),
      input.record,
    );
    await cp(
      path.join(input.reviewDir, "review.json"),
      path.join(backup, "review.json"),
    );
    try {
      for (const name of replacementNames) {
        let hadOriginal = true;
        try {
          await renamePath(
            path.join(input.reviewDir, name),
            path.join(backup, name),
          );
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          hadOriginal = false;
        }
        replacements.push({ name, hadOriginal });
        // The upgraded database is checkpointed; retire its old WAL/SHM
        // together with the database and restore all three on failure.
        if (name !== "review.db-wal" && name !== "review.db-shm")
          await renamePath(
            path.join(prepared, name),
            path.join(input.reviewDir, name),
          );
      }
      await renamePath(
        path.join(prepared, "review.json"),
        path.join(input.reviewDir, "review.json"),
      );
    } catch (error) {
      try {
        for (const { name, hadOriginal } of replacements.reverse()) {
          await rm(path.join(input.reviewDir, name), {
            recursive: true,
            force: true,
          });
          if (hadOriginal) {
            await renamePath(
              path.join(backup, name),
              path.join(input.reviewDir, name),
            );
          }
        }
      } catch (rollbackError) {
        retainBackup = true;
        throw new AggregateError(
          [error, rollbackError],
          `Review rollback could not complete. Original review files remain in ${input.reviewDir} and ${backup}.`,
        );
      }
      throw error;
    }
  } finally {
    if (!retainBackup) await rm(staging, { recursive: true, force: true });
  }
}
