import { errorMessage } from "@dev.fast/trace-core";

import type { LocalReviewData } from "../review-api/local-data";
import type { ReviewStore } from "../review-api/store";
import type { StoredReview } from "../review-home";
import type { ReviewVcsLogEntry } from "../review-vcs";
import { type ImportOutcome, importLegacyReview } from "./import-review";

export type ImportedOutcome = Extract<ImportOutcome, { kind: "imported" }>;

/** The server's one importer: Home sweeps through it in the background and
 * open waits on it, sharing any import already in flight for a review. */
export interface LegacyImporter {
  /** Import every listed review the store lacks; never rejects. */
  sweep(reviews: StoredReview[]): Promise<ImportOutcome[]>;
  /** Import this review now, or join the import already running for it. */
  ensure(review: StoredReview): Promise<ImportOutcome>;
}

export function createLegacyImporter(input: {
  store: ReviewStore;
  data: LocalReviewData;
  materialize: (review: StoredReview, revision: string) => Promise<string>;
  onImported: (review: StoredReview, outcome: ImportedOutcome) => Promise<void>;
  log: (message: string) => void;
  /** The server's per-review lock, so an import never interleaves with a
   * promotion of the same review. */
  lock?: <T>(uuid: string, operation: () => Promise<T>) => Promise<T>;
  /** Test seam for the review's sealed-revision log. */
  revisionLog?: (dir: string) => Promise<ReviewVcsLogEntry[]>;
  concurrency?: number;
}): LegacyImporter {
  const inFlight = new Map<string, Promise<ImportOutcome>>();
  const lock = input.lock ?? ((_uuid, operation) => operation());
  // Every Home list sweeps again; a review that cannot import, or cannot
  // import its map, says so once.
  const reported = new Map<string, string>();

  const report = (uuid: string, reason: string) => {
    if (reported.get(uuid) === reason) return;
    reported.set(uuid, reason);
    input.log(`[Review import] ${uuid}: ${reason}`);
  };

  // Imports of one review run one after another rather than joining: a
  // request that arrives while an older revision is importing waits, then
  // imports whatever that run left behind.
  const ensure = (review: StoredReview): Promise<ImportOutcome> => {
    const uuid = review.review.uuid;
    const previous = inFlight.get(uuid) ?? Promise.resolve();

    const run = previous
      .then(() =>
        lock(uuid, () =>
          importLegacyReview({
            review,
            store: input.store,
            data: input.data,
            materialize: input.materialize,
            log: input.revisionLog,
          }),
        ),
      )
      .catch(
        (error): ImportOutcome => ({
          kind: "skipped",
          reviewId: uuid,
          reason: errorMessage(error),
        }),
      )
      .then(async (outcome) => {
        if (outcome.kind === "skipped")
          report(uuid, `skipped (${outcome.reason})`);

        // A current document whose map failed: the review still opens.
        if (outcome.kind === "current" && outcome.warnings?.length)
          report(uuid, outcome.warnings.join("; "));

        if (outcome.kind === "imported") {
          input.log(
            `[Review import] ${uuid}: imported as version ${outcome.version}${
              outcome.warnings.length
                ? ` with warnings: ${outcome.warnings.join("; ")}`
                : ""
            }`,
          );

          try {
            await input.onImported(review, outcome);
          } catch (error) {
            input.log(`[Review import] ${uuid}: ${errorMessage(error)}`);
          }
        }

        return outcome;
      })
      .finally(() => {
        if (inFlight.get(uuid) === run) inFlight.delete(uuid);
      });

    inFlight.set(uuid, run);

    return run;
  };

  const sweep = async (reviews: StoredReview[]): Promise<ImportOutcome[]> => {
    const queue = [...reviews];
    const outcomes: ImportOutcome[] = [];

    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        outcomes.push(await ensure(next));
    };

    await Promise.all(
      Array.from({ length: input.concurrency ?? 4 }, () => worker()),
    );

    return outcomes;
  };

  return { sweep, ensure };
}
