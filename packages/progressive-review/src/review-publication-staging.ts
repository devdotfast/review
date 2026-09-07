import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import {
  type ReviewTreeOptions,
  copyReviewTree,
  fingerprintReviewTree,
} from "./review-tree-fingerprint";

interface StagedReviewDocument {
  bundle: ReviewDocumentBundle;
  warnings: string[];
  fingerprint: string;
  sourceFingerprint: string;
}

export async function stageReviewDocumentPublication(input: {
  review: StoredReview;
  source?: string;
}): Promise<StagedReviewDocument> {
  const stagingDir = await mkdtemp(
    path.join(path.dirname(input.review.dir), ".review-publish-"),
  );
  try {
    const fingerprint = await copyAuthoringTree(input.review.dir, stagingDir);
    if (fingerprint !== (await fingerprintAuthoring(input.review.dir)))
      throw authoringChanged();
    if (input.source !== undefined)
      await writeFile(path.join(stagingDir, "review.mdx"), input.source);
    const sourceFingerprint =
      input.source === undefined
        ? fingerprint
        : await fingerprintAuthoring(stagingDir);
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
    const prepared = await prepareReviewDocumentBundle({
      review: { ...input.review, dir: stagingDir },
    });
    return {
      bundle: prepared.bundle,
      warnings: prepared.warnings,
      fingerprint,
      sourceFingerprint,
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

const authoringTreeOptions = {
  include: (relativePath: string) =>
    relativePath.includes(path.sep) || isAuthoringInput(relativePath),
  symlink: "reject",
} satisfies ReviewTreeOptions;

export async function fingerprintAuthoring(reviewDir: string): Promise<string> {
  return fingerprintReviewTree(reviewDir, authoringTreeOptions);
}

async function copyAuthoringTree(
  reviewDir: string,
  destination: string,
): Promise<string> {
  return copyReviewTree(reviewDir, destination, authoringTreeOptions);
}
