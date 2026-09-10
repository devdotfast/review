import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type StoredReview,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
} from "../review-home";
import { reviewSourcePins } from "../review-source-pins";
import { withFileLock } from "../with-file-lock";

const CACHE_MARKER = ".review-materialized.json";
const CacheMarkerSchema = z.strictObject({
  format: z.literal("review-materialization/1"),
  revision: z.string(),
});

export async function materializePublishRevision(
  input: {
    review: StoredReview;
    revision: string;
    /** Repairs read candidate Git objects while installing in the live cache. */
    sourceDir?: string;
  },
  dependencies: { materialize?: typeof materializeReviewRevision } = {},
): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(input.revision)) {
    throw new Error(`Review revision is invalid: ${input.revision}`);
  }
  const revision = input.revision.toLowerCase();
  const buildRoot = path.join(input.review.dir, ".build");
  const destinationPath = path.join(buildRoot, revision);
  const isComplete = async () => {
    try {
      const marker = CacheMarkerSchema.parse(
        parseJsonText(
          await readFile(path.join(destinationPath, CACHE_MARKER), "utf8"),
        ),
      );
      if (marker.revision !== revision) return false;
      const record = await readPresentedReviewRecord(destinationPath);
      return record.uuid === input.review.review.uuid;
    } catch {
      return false;
    }
  };
  if (await isComplete()) return destinationPath;
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const temporaryPath = await mkdtemp(
    path.join(buildRoot, `.materialize-${revision}-`),
  );
  try {
    await (dependencies.materialize ?? materializeReviewRevision)(
      input.sourceDir ?? input.review.dir,
      revision,
      temporaryPath,
    );
    const record = await readPresentedReviewRecord(temporaryPath);
    if (record.uuid !== input.review.review.uuid)
      throw new Error("Sealed Review UUID does not match its store.");
    await writeFile(
      path.join(temporaryPath, CACHE_MARKER),
      JSON.stringify({ format: "review-materialization/1", revision }),
      { mode: 0o600 },
    );
    // Only completed trees compete for installation. This lock is separate
    // from review mutations, so materialization never blocks publish/stop.
    const installed = await withFileLock(
      path.join(buildRoot, `.install-${revision}`),
      {
        retryMs: 20,
        timeoutMs: 10_000,
        staleMs: 120_000,
        heartbeatMs: 5_000,
        unownedGraceMs: 1_000,
      },
      async () => {
        if (await isComplete()) return;
        await rm(destinationPath, { recursive: true, force: true });
        await rename(temporaryPath, destinationPath);
      },
    );
    if (!installed.acquired)
      throw new Error(
        `Review cache for ${revision} is busy; retry opening it.`,
      );
    return destinationPath;
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

export async function readPresentedReviewRecord(documentBuildDir: string) {
  return parseAnyStoredReviewRecord(
    parseJsonText(
      await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
    ),
  );
}

/** A presentation is pinned by the revision it was sealed from, not by the
 * review's current pins. */
export async function reviewWithPresentedDocumentPins(
  stored: StoredReview,
  documentBuildDir: string,
  presentedRecord?: Awaited<ReturnType<typeof readPresentedReviewRecord>>,
): Promise<StoredReview> {
  const presented =
    presentedRecord ?? (await readPresentedReviewRecord(documentBuildDir));
  return {
    ...stored,
    review: {
      ...stored.review,
      ...reviewSourcePins(presented),
    },
  };
}
