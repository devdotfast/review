import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { type StoredReview, materializeReviewRevision } from "../review-home";

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
