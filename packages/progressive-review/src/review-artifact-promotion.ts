import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./native-agent/transcript-json";

/** The database and the two sidecars a checkpointed upgrade retires with it. */
const THREAD_DATABASE_FILES = ["review.db", "review.db-wal", "review.db-shm"];

/**
 * Swaps a Review's own legacy thread database for the upgraded copy `review
 * repair` built in isolation, keeping the original until the swap is done.
 *
 * The last file-level promotion in the Review directory: publication bytes
 * live in the content-addressed artifact store, which is never overwritten.
 */
export async function promoteLegacyThreadDatabase(input: {
  reviewDir: string;
  candidateDir: string;
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
    await cp(
      path.join(input.candidateDir, "review.db"),
      path.join(prepared, "review.db"),
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await commitLegacyThreadDatabasePromotion({
    reviewDir: input.reviewDir,
    stagingDir: staging,
  });
}

export async function commitLegacyThreadDatabasePromotion(input: {
  reviewDir: string;
  stagingDir: string;
}): Promise<void> {
  const prepared = path.join(input.stagingDir, "prepared");
  const backup = path.join(input.stagingDir, "backup");
  const replacements: Array<{ name: string; hadOriginal: boolean }> = [];
  try {
    for (const name of THREAD_DATABASE_FILES) {
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
      if (name === "review.db")
        await rename(
          path.join(prepared, name),
          path.join(input.reviewDir, name),
        );
    }
  } catch (error) {
    await rollbackLegacyThreadDatabasePromotion({
      reviewDir: input.reviewDir,
      stagingDir: input.stagingDir,
      replacements,
      error,
    });
  }
  await rm(input.stagingDir, { recursive: true, force: true });
}

export async function rollbackLegacyThreadDatabasePromotion(input: {
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
