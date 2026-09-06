import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  type StoredReview,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
} from "../review-home";

export async function materializePublishRevision(input: {
  review: StoredReview;
  revision: string;
}): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(input.revision)) {
    throw new Error(`Review revision is invalid: ${input.revision}`);
  }
  const destinationPath = path.join(input.review.dir, ".build", input.revision);
  try {
    if ((await stat(destinationPath)).isDirectory()) return destinationPath;
  } catch (error) {
    // SAFETY: fs/promises stat rejects with a Node ErrnoException carrying `code`.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await materializeReviewRevision(
    input.review.dir,
    input.revision,
    destinationPath,
  );
  return destinationPath;
}

/** A presentation is pinned by the revision it was sealed from, not by the
 * review's current pins. */
export async function reviewWithPresentedDocumentPins(
  stored: StoredReview,
  documentBuildDir: string,
): Promise<StoredReview> {
  const presented = parseAnyStoredReviewRecord(
    JSON.parse(
      await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
    ),
  );
  return {
    ...stored,
    review: {
      ...stored.review,
      baseRef: presented.baseRef,
      baseCommit: presented.baseCommit,
      sourceCommit: presented.sourceCommit,
      sourceIdentity: presented.sourceIdentity,
    },
  };
}
