import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";

import { withFileLock } from "./with-file-lock";

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Call under the mutation lock before writing a candidate prepared earlier. */
export async function assertReviewUnchanged(
  reviewDir: string,
  expected: {
    sourceCommit: string | null;
    baseCommit: string;
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
    "status",
    "presentedDocumentRevision",
    "presentedSoftwareMapRevision",
  ] as const) {
    if (actual?.[key] !== expected[key])
      throw new Error(
        "Review changed while preparing publication; rerun the publish command.",
      );
  }
}

/** Shared by the desktop and migration CLI; stored outside the sealed tree. */
export async function withReviewMutationLock<T>(
  reviewDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonicalDir = path.resolve(reviewDir);
  const inherited = heldLocks.getStore();
  if (inherited?.has(canonicalDir)) return operation();
  const outcome = await withFileLock(
    `${reviewDir}.mutation-lock`,
    {
      retryMs: 20,
      timeoutMs: 10_000,
      staleMs: 120_000,
      heartbeatMs: 5_000,
      unownedGraceMs: 1_000,
    },
    () =>
      heldLocks.run(new Set([...(inherited ?? []), canonicalDir]), operation),
  );
  if (!outcome.acquired)
    throw new Error(
      `Review ${path.basename(reviewDir)} is busy; retry migration after its current operation completes.`,
    );
  return outcome.result;
}
