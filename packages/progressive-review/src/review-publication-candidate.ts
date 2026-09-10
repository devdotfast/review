import { installReviewArtifact } from "./review-artifact-store";
import type { StoredReview, StoredReviewRecord } from "./review-home";
import {
  type GuardedReviewField,
  assertReviewUnchanged,
  withReviewMutationLock,
} from "./review-mutation-lock";
import type { SourceContext } from "./review-publication-record";
import {
  type ReviewSoftwareMapBundle,
  softwareMapArtifactBytes,
} from "./software-map-bundle";

/** The guarded values a candidate was prepared against; the activation that
 * commits it refuses to run when the record no longer matches. */
export type ExpectedReviewFields = Pick<StoredReviewRecord, GuardedReviewField>;

/** A document artifact installed in the store and ready to activate. */
export interface PreparedDocumentCandidate {
  kind: "document";
  reviewUuid: string;
  artifactHash: string;
  /** The staged `review.mdx`'s first H1, or undefined when it has none. */
  title: string | undefined;
  context: SourceContext;
  expected: ExpectedReviewFields;
  authoringFingerprint: string;
  warnings: string[];
}

/** A software-map artifact installed in the store and ready to activate. */
export interface PreparedSoftwareMapCandidate {
  kind: "map";
  reviewUuid: string;
  artifactHash: string;
  headCommit: string;
  baseCommit: string;
  context: SourceContext;
  expected: ExpectedReviewFields;
}

/** The code the Review is pinned to right now, snapshotted for a candidate. */
export function reviewSourceContext(record: StoredReviewRecord): SourceContext {
  return {
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    sourceCommit: record.sourceCommit,
    sourceIdentity: record.sourceIdentity,
  };
}

/** Installs the map bytes under the mutation lock, after rechecking that the
 * record they were prepared against still holds. Nothing points at them yet. */
export async function prepareReviewSoftwareMapCandidate(input: {
  review: StoredReview;
  bundle: ReviewSoftwareMapBundle;
}): Promise<PreparedSoftwareMapCandidate> {
  return withReviewMutationLock(input.review.dir, async () => {
    await assertReviewUnchanged(input.review.dir, input.review.review);
    const installed = await installReviewArtifact(
      input.review.dir,
      "map",
      softwareMapArtifactBytes(input.bundle),
    );
    return {
      kind: "map",
      reviewUuid: input.review.review.uuid,
      artifactHash: installed.hash,
      headCommit: input.bundle.headCommit,
      baseCommit: input.bundle.baseCommit,
      context: reviewSourceContext(input.review.review),
      expected: input.review.review,
    };
  });
}
