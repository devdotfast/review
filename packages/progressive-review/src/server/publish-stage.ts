import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  type StoredReview,
  materializeReviewRevision,
  parseStoredReviewRecord,
  reviewsHomeDir,
} from "../review-home";

export async function findPublishReview(
  uuid: string,
): Promise<StoredReview | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      uuid,
    )
  ) {
    throw new Error(`Review UUID is invalid: ${uuid}`);
  }
  const dir = path.join(reviewsHomeDir(), uuid);
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(dir, "review.json"), "utf8"),
    );
    const review = parseStoredReviewRecord(value);
    if (review.uuid !== uuid)
      throw new Error("Review UUID does not match its directory.");
    return { dir, review };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

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
