import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonAtomic } from "@dev.fast/trace-core";

import { isMissingFileError } from "./fs-utils";
import {
  type WhiteboardRecord,
  WhiteboardRecordSchema,
} from "./review-import/legacy-record";

export async function promoteWhiteboardArtifactFiles(input: {
  whiteboardDir: string;
  candidateDir: string;
  record: WhiteboardRecord;
}): Promise<void> {
  const staging = await mkdtemp(
    path.join(
      path.dirname(input.whiteboardDir),
      `.${path.basename(input.whiteboardDir)}-promotion-`,
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

    await writePrivateJsonAtomic(
      path.join(prepared, "review.json"),
      input.record,
    );
    await cp(
      path.join(input.whiteboardDir, "review.json"),
      path.join(backup, "review.json"),
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await commitWhiteboardArtifactPromotion({
    whiteboardDir: input.whiteboardDir,
    stagingDir: staging,
  });
}

async function commitWhiteboardArtifactPromotion(input: {
  whiteboardDir: string;
  stagingDir: string;
}): Promise<void> {
  const prepared = path.join(input.stagingDir, "prepared");
  const backup = path.join(input.stagingDir, "backup");
  const replacements: Array<{ name: string; hadOriginal: boolean }> = [];

  try {
    for (const name of [".bundle", ".git"]) {
      let hadOriginal = true;

      try {
        await rename(
          path.join(input.whiteboardDir, name),
          path.join(backup, name),
        );
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        hadOriginal = false;
      }

      replacements.push({ name, hadOriginal });
      await rename(
        path.join(prepared, name),
        path.join(input.whiteboardDir, name),
      );
    }

    await rename(
      path.join(prepared, "review.json"),
      path.join(input.whiteboardDir, "review.json"),
    );
  } catch (error) {
    await rollbackWhiteboardArtifactPromotion({
      whiteboardDir: input.whiteboardDir,
      stagingDir: input.stagingDir,
      replacements,
      error,
    });
  }

  await rm(input.stagingDir, { recursive: true, force: true });
}

async function rollbackWhiteboardArtifactPromotion(input: {
  whiteboardDir: string;
  stagingDir: string;
  replacements: Array<{ name: string; hadOriginal: boolean }>;
  error: unknown;
}): Promise<never> {
  const backup = path.join(input.stagingDir, "backup");

  try {
    for (const { name, hadOriginal } of input.replacements.reverse()) {
      await rm(path.join(input.whiteboardDir, name), {
        recursive: true,
        force: true,
      });

      if (hadOriginal) {
        await rename(
          path.join(backup, name),
          path.join(input.whiteboardDir, name),
        );
      }
    }
  } catch (rollbackError) {
    throw new AggregateError(
      [input.error, rollbackError],
      `Whiteboard rollback could not complete. Original session files remain in ${input.whiteboardDir} and ${backup}.`,
    );
  }

  await rm(input.stagingDir, { recursive: true, force: true });
  throw input.error;
}
