import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ReviewDocumentFile,
  ReviewDocumentFileName,
  ReviewDocumentFileWrite,
} from "@dev.fast/review-protocol";

import { writeFileAtomicAsync } from "./atomic-write";
import {
  ReviewDocumentApiError,
  parseIncrementalReviewDocument,
} from "./incremental-review-document";
import type { StoredReview } from "./review-home";

export async function readReviewDocumentFile(
  review: StoredReview,
  name: ReviewDocumentFileName,
): Promise<ReviewDocumentFile> {
  try {
    const source = await readFile(path.join(review.dir, name), "utf8");
    return {
      name,
      source,
      sourceHash: createHash("sha256").update(source).digest("hex"),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { name, source: null, sourceHash: null };
    }
    throw error;
  }
}

/** Called under the same review lock as node mutations and publication. */
export async function writeReviewDocumentFile(
  review: StoredReview,
  name: ReviewDocumentFileName,
  request: ReviewDocumentFileWrite,
): Promise<ReviewDocumentFile> {
  const current = await readReviewDocumentFile(review, name);
  if (
    name === "review.mdx" &&
    (parseIncrementalReviewDocument(current.source ?? "") ||
      parseIncrementalReviewDocument(request.source))
  ) {
    throw new ReviewDocumentApiError(
      "Use the node mutation API to author incremental documents.",
      409,
      "incremental_document",
    );
  }
  // A retry after a lost response is safe if the requested contents already won.
  if (current.source === request.source) return current;
  if (current.sourceHash !== request.expectedSourceHash) {
    throw new ReviewDocumentApiError(
      "Document input changed; read it again before writing.",
      409,
      "source_conflict",
    );
  }
  await writeFileAtomicAsync(path.join(review.dir, name), request.source, {
    encoding: "utf8",
    mode: 0o600,
  });
  return readReviewDocumentFile(review, name);
}
