import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./native-agent/transcript-json";
import { installReviewArtifact } from "./review-artifact-store";
import type { ReviewDocumentBundle } from "./review-bundle";
import { isAuthoringInput } from "./review-derived-paths";
import { type StoredReview, reviewTitleFromDocument } from "./review-home";
import {
  assertReviewUnchanged,
  withReviewMutationLock,
} from "./review-mutation-lock";
import {
  type PreparedDocumentCandidate,
  reviewSourceContext,
} from "./review-publication-candidate";
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

export interface StagedReviewDocument {
  bundle: ReviewDocumentBundle;
  warnings: string[];
  fingerprint: string;
  sourceFingerprint: string;
  /** The staged document's own title, read before the staging copy is
   * removed, so a publication records the title of the bytes it publishes. */
  title: string | undefined;
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
      title: await reviewTitleFromDocument(path.join(stagingDir, "review.mdx")),
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

/**
 * Installs the staged document's bytes in the artifact store under the
 * mutation lock, after rechecking everything the staging run assumed: the
 * guarded record, the authoring tree, and both republication thread gates.
 * Nothing points at the artifact until an activation commits it.
 */
export async function prepareReviewDocumentCandidate(input: {
  review: StoredReview;
  document: StagedReviewDocument;
}): Promise<PreparedDocumentCandidate> {
  return withReviewMutationLock(input.review.dir, async () => {
    await assertReviewUnchanged(input.review.dir, input.review.review);
    if (
      input.document.fingerprint !==
      (await fingerprintAuthoring(input.review.dir))
    )
      throw authoringChanged();
    requireClosedThreadsForRepublish(input.review);
    requireCompletedAgentResponsesForRepublish(input.review);
    const installed = await installReviewArtifact(
      input.review.dir,
      "document",
      input.document.bundle.json,
    );
    return {
      kind: "document",
      reviewUuid: input.review.review.uuid,
      artifactHash: installed.hash,
      title: input.document.title,
      context: reviewSourceContext(input.review.review),
      expected: input.review.review,
      authoringFingerprint: input.document.fingerprint,
      warnings: input.document.warnings,
    };
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
