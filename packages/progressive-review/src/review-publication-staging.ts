import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./native-agent/transcript-json";
import {
  type ReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { isAuthoringInput } from "./review-derived-paths";
import { REVIEW_PUBLISH_CANDIDATE_MESSAGE } from "./review-document-versions";
import { type StoredReview, sealReviewCandidate } from "./review-home";
import {
  assertReviewUnchanged,
  withReviewMutationLock,
} from "./review-mutation-lock";
import {
  ReviewPublicationValidationError,
  prepareReviewDocumentBundle,
} from "./review-publication-preparation";
import {
  requireClosedThreadsForRepublish,
  requireCompletedAgentResponsesForRepublish,
} from "./review-publish-thread-gate";

interface StagedReviewDocument {
  bundle: ReviewDocumentBundle;
  warnings: string[];
  fingerprint: string;
}

export async function stageReviewDocumentPublication(input: {
  review: StoredReview;
  prepareDocument?: typeof prepareReviewDocumentBundle;
}): Promise<StagedReviewDocument> {
  const stagingDir = await mkdtemp(
    path.join(path.dirname(input.review.dir), ".review-publish-"),
  );
  try {
    const fingerprint = await fingerprintAuthoring(
      input.review.dir,
      stagingDir,
    );
    if (fingerprint !== (await fingerprintAuthoring(input.review.dir)))
      throw authoringChanged();
    const dependencies = path.join(input.review.dir, "node_modules");
    let hasDependencies = true;
    try {
      await lstat(dependencies);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      hasDependencies = false;
    }
    if (hasDependencies) {
      await symlink(
        dependencies,
        path.join(stagingDir, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await writeFile(
      path.join(stagingDir, "review.json"),
      JSON.stringify(input.review.review),
    );
    const prepared = await (
      input.prepareDocument ?? prepareReviewDocumentBundle
    )({
      review: { ...input.review, dir: stagingDir },
    });
    return {
      bundle: prepared.bundle,
      warnings: prepared.warnings,
      fingerprint,
    };
  } catch (error) {
    if (error instanceof ReviewPublicationValidationError) {
      throw new ReviewPublicationValidationError(
        error.errors,
        error.diagnostics?.map((diagnostic) => ({
          ...diagnostic,
          filePath: diagnostic.filePath.replace(stagingDir, input.review.dir),
        })),
        error.warnings,
      );
    }
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function sealReviewDocumentPublication(input: {
  review: StoredReview;
  document: StagedReviewDocument;
}): Promise<string> {
  return withReviewMutationLock(input.review.dir, async () => {
    await assertReviewUnchanged(input.review.dir, input.review.review);
    if (
      input.document.fingerprint !==
      (await fingerprintAuthoring(input.review.dir))
    )
      throw authoringChanged();
    requireClosedThreadsForRepublish(input.review);
    requireCompletedAgentResponsesForRepublish(input.review);
    await writeReviewDocumentBundle(input.review.dir, input.document.bundle);
    return sealReviewCandidate(
      input.review.dir,
      REVIEW_PUBLISH_CANDIDATE_MESSAGE,
    );
  });
}

function authoringChanged(): Error {
  return new Error(
    "Review authoring changed while preparing publication; rerun the publish command.",
  );
}

async function fingerprintAuthoring(
  reviewDir: string,
  destination?: string,
): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(reviewDir, relativeDir), {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!relativeDir && !isAuthoringInput(entry.name)) continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Review authoring contains an unsupported symbolic link: ${relativePath}`,
        );
      if (entry.isDirectory()) {
        if (destination)
          await mkdir(path.join(destination, relativePath), {
            recursive: true,
          });
        await visit(relativePath);
      } else if (entry.isFile()) {
        const contents = await readFile(path.join(reviewDir, relativePath));
        hash.update(JSON.stringify([relativePath, contents.length]));
        hash.update(contents);
        if (destination)
          await writeFile(path.join(destination, relativePath), contents);
      } else {
        throw new Error(
          `Review authoring contains an unsupported file: ${relativePath}`,
        );
      }
    }
  }
  await visit("");
  return hash.digest("hex");
}
