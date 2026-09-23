import { errorMessage } from "@dev.fast/trace-core";

import type { LocalSessionData } from "../session-api/local-data";
import type { SessionStore } from "../session-api/store";
import type { StoredWhiteboard } from "../whiteboard-home";
import type { WhiteboardVcsLogEntry } from "../whiteboard-vcs";
import { type ImportOutcome, importLegacyWhiteboard } from "./import-review";

export type ImportedOutcome = Extract<ImportOutcome, { kind: "imported" }>;

/** The server's one importer: Home sweeps through it in the background and
 * open waits on it, sharing any import already in flight for a review. */
export interface LegacyImporter {
  /** Import every listed review the store lacks; never rejects. */
  sweep(reviews: StoredWhiteboard[]): Promise<ImportOutcome[]>;
  /** Import this review now, or join the import already running for it. */
  ensure(review: StoredWhiteboard): Promise<ImportOutcome>;
}

export function createLegacyImporter(input: {
  store: SessionStore;
  data: LocalSessionData;
  materialize: (review: StoredWhiteboard, revision: string) => Promise<string>;
  onImported: (
    review: StoredWhiteboard,
    outcome: ImportedOutcome,
  ) => Promise<void>;
  log: (message: string) => void;
  /** The server's per-review lock, so an import never interleaves with a
   * promotion of the same review. */
  lock?: <T>(uuid: string, operation: () => Promise<T>) => Promise<T>;
  /** Test seam for the review's sealed-revision log. */
  revisionLog?: (dir: string) => Promise<WhiteboardVcsLogEntry[]>;
  concurrency?: number;
}): LegacyImporter {
  const inFlight = new Map<string, Promise<ImportOutcome>>();
  const lock = input.lock ?? ((_uuid, operation) => operation());
  // Every Home list sweeps again; each failure is logged once.
  const reported = new Map<string, string>();

  const report = (uuid: string, reason: string) => {
    if (reported.get(uuid) === reason) return;
    reported.set(uuid, reason);
    input.log(`[Review import] ${uuid}: ${reason}`);
  };

  // Imports of one review run one after another rather than joining: a
  // request that arrives while an older revision is importing waits, then
  // imports whatever that run left behind.
  const ensure = (review: StoredWhiteboard): Promise<ImportOutcome> => {
    const uuid = review.review.uuid;
    const previous = inFlight.get(uuid) ?? Promise.resolve();

    const run = previous
      .then(() =>
        lock(uuid, () =>
          importLegacyWhiteboard({
            review,
            store: input.store,
            data: input.data,
            materialize: input.materialize,
            log: input.revisionLog,
          }),
        ),
      )
      .catch((error): ImportOutcome => {
        // A review the store holds is what Home lists and opens: it stays current.
        if (input.store.has(uuid))
          return {
            kind: "current",
            sessionId: uuid,
            warnings: [errorMessage(error)],
          };

        return {
          kind: "skipped",
          sessionId: uuid,
          reason: errorMessage(error),
        };
      })
      .then(async (outcome) => {
        if (outcome.kind === "skipped")
          report(uuid, `skipped (${outcome.reason})`);

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

  const sweep = async (
    reviews: StoredWhiteboard[],
  ): Promise<ImportOutcome[]> => {
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
