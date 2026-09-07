import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "./atomic-write";
import type { StoredReview } from "./review-home";
import type { ReviewDocumentFileName } from "./review-lifecycle-contracts";
import { ReviewServerError } from "./server/http-json";

export async function readReviewDocumentFile(
  review: StoredReview,
  name: ReviewDocumentFileName,
) {
  const filePath = path.join(review.dir, name);
  try {
    if (!(await lstat(filePath)).isFile()) {
      throw new ReviewServerError(
        "Document source must be a regular file, not a symlink.",
        409,
      );
    }
    const source = await readFile(filePath, "utf8");
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

/** The caller holds the Review mutation lock across comparison and replacement. */
export async function writeReviewDocumentFile(
  review: StoredReview,
  input: {
    name: ReviewDocumentFileName;
    source: string;
    expectedSourceHash: string | null;
  },
) {
  const current = await readReviewDocumentFile(review, input.name);
  if (current.source === input.source) return current;
  if (current.sourceHash !== input.expectedSourceHash) {
    throw new ReviewServerError(
      "Document source changed. Read it again before retrying.",
      409,
    );
  }
  await writeFileAtomicAsync(path.join(review.dir, input.name), input.source, {
    encoding: "utf8",
    mode: 0o600,
  });
  return readReviewDocumentFile(review, input.name);
}
