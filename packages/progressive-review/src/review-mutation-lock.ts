import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";

import { withFileLock } from "./with-file-lock";

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export class ReviewBusyError extends Error {
  override readonly name = "ReviewBusyError";
  readonly code = "REVIEW_BUSY";
  readonly retryable = true;
  readonly reviewUuid: string;

  constructor(reviewDir: string) {
    const reviewUuid = path.basename(reviewDir);
    super(
      `Review ${reviewUuid} is busy. Retry after its current operation completes.`,
    );
    this.reviewUuid = reviewUuid;
  }
}

/** Call under the mutation lock before writing a candidate prepared earlier. */
export async function assertReviewUnchanged(
  reviewDir: string,
  expected: {
    sourceCommit: string | null;
    baseCommit: string;
    baseRef: string;
    worktreePath: string;
    sourceIdentity: unknown;
    status: string;
    presentedDocumentRevision: string | null;
    presentedSoftwareMapRevision: string | null;
  },
): Promise<void> {
  const actual = jsonObject(
    parseJsonText(await readFile(path.join(reviewDir, "review.json"), "utf8")),
  );
  for (const key of [
    "sourceCommit",
    "baseCommit",
    "baseRef",
    "worktreePath",
    "sourceIdentity",
    "status",
    "presentedDocumentRevision",
    "presentedSoftwareMapRevision",
  ] as const) {
    if (!isDeepStrictEqual(actual?.[key], expected[key]))
      throw new Error(
        "Review changed while preparing publication; rerun the publish command.",
      );
  }
}

/** Shared by the desktop and migration CLI; stored outside the sealed tree. */
export async function withReviewMutationLock<T>(
  reviewDir: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const canonicalDir = path.resolve(reviewDir);
  const inherited = heldLocks.getStore();
  if (inherited?.has(canonicalDir)) return operation();
  const outcome = await withFileLock(
    `${reviewDir}.mutation-lock`,
    {
      retryMs: 20,
      timeoutMs: options.timeoutMs ?? 10_000,
      staleMs: 120_000,
      heartbeatMs: 5_000,
      unownedGraceMs: 1_000,
    },
    () =>
      heldLocks.run(new Set([...(inherited ?? []), canonicalDir]), operation),
  );
  if (!outcome.acquired) throw new ReviewBusyError(reviewDir);
  return outcome.result;
}
