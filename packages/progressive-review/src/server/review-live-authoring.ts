import { parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { bundleReviewDocument } from "../review-bundle";
import { reviewDocumentDataSchema } from "../review-document-data";
import {
  readReviewDocumentFile,
  writeReviewDocumentFile,
} from "../review-document-files";
import type { StoredReview } from "../review-home";
import {
  type ReviewLiveMutation,
  parseLiveDocument,
  planLiveMutation,
} from "../review-live-document";
import {
  assertReviewUnchanged,
  reviewMutationFingerprint,
} from "../review-mutation-lock";
import {
  fingerprintAuthoring,
  stageReviewDocumentPublication,
} from "../review-publication-staging";
import {
  ensureReviewRegistration,
  openReviewStateDb,
  reviewHomeForDir,
} from "../review-state-db";
import { ReviewServerError } from "./http-json";

const projectionSchema = z.object({
  fingerprint: z.string(),
  recordFingerprint: z.string(),
  document: reviewDocumentDataSchema,
});

export async function readLiveSnapshot(review: StoredReview) {
  const current = await readReviewDocumentFile(review, "review.mdx");
  const live = parseLiveDocument(current.source);
  return {
    reviewUuid: review.review.uuid,
    mode: live ? "incremental" : "compiled",
    sourceHash: current.sourceHash,
    revision: live?.revision ?? 0,
    nodes: live?.nodes ?? [],
  };
}

/** Caller serializes mutations with the desktop's per-Review lock. */
export async function mutateLiveDocument(
  review: StoredReview,
  request: ReviewLiveMutation,
) {
  const current = await readReviewDocumentFile(review, "review.mdx");
  const source = planLiveMutation(current, request);
  const staged = await stageReviewDocumentPublication({ review, source });
  await assertReviewUnchanged(review.dir, review.review);
  if (staged.fingerprint !== (await fingerprintAuthoring(review.dir)))
    throw new ReviewServerError(
      "Authoring inputs changed while compiling. Read the document and retry.",
      409,
    );
  await writeReviewDocumentFile(review, {
    name: "review.mdx",
    source,
    expectedSourceHash: current.sourceHash,
  });
  await saveProjection(review, staged.bundle.json, staged.sourceFingerprint);
  return readLiveSnapshot(review);
}

/** Live projections never replace the sealed bundle or historical revisions. */
export async function readLiveBundle(review: StoredReview) {
  const source = await readReviewDocumentFile(review, "review.mdx");
  if (!parseLiveDocument(source.source)) return null;
  const db = openReviewStateDb(reviewHomeForDir(review.dir));
  const row = db
    .prepare(
      "SELECT projection_json FROM documents WHERE review_id = ? AND route_path = '/'",
    )
    .get(review.review.uuid);
  const cached = z.string().safeParse(row?.projection_json);
  const projection = cached.success
    ? projectionSchema.safeParse(parseJsonText(cached.data))
    : null;
  if (
    projection?.success &&
    projection.data.recordFingerprint ===
      reviewMutationFingerprint(review.review) &&
    projection.data.fingerprint === (await fingerprintAuthoring(review.dir))
  )
    return bundleReviewDocument(projection.data.document);
  // Recover after a crash between the atomic MDX write and projection caching,
  // or rebuild after data.ts changes. Never serve a projection for different pins.
  const staged = await stageReviewDocumentPublication({ review });
  await assertReviewUnchanged(review.dir, review.review);
  if (staged.fingerprint !== (await fingerprintAuthoring(review.dir)))
    throw new ReviewServerError(
      "Authoring inputs changed while compiling the live document.",
      409,
    );
  await saveProjection(review, staged.bundle.json, staged.fingerprint);
  return staged.bundle;
}

async function saveProjection(
  review: StoredReview,
  json: string,
  fingerprint: string,
) {
  const snapshot = await readLiveSnapshot(review);
  ensureReviewRegistration(review.dir);
  const db = openReviewStateDb(reviewHomeForDir(review.dir));
  db.prepare(`INSERT INTO documents (review_id, route_path, mode, revision, source_hash, projection_json)
    VALUES (?, '/', 'incremental', ?, ?, ?)
    ON CONFLICT(review_id, route_path) DO UPDATE SET
      mode = excluded.mode, revision = excluded.revision,
      source_hash = excluded.source_hash, projection_json = excluded.projection_json`).run(
    review.review.uuid,
    snapshot.revision,
    snapshot.sourceHash,
    JSON.stringify({
      fingerprint,
      recordFingerprint: reviewMutationFingerprint(review.review),
      document: parseJsonText(json),
    }),
  );
}
