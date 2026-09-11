import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  type ReviewErrorResponse,
  isJsonObject,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import type { StoredReviewRecord } from "./review-home";
import { withFileLock } from "./with-file-lock";

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Pins, lifecycle and presentation pointers. A publication or repair prepared
 * against these values may only be written while they still hold. */
export const GUARDED_REVIEW_FIELDS = [
  "sourceCommit",
  "baseCommit",
  "baseRef",
  "worktreePath",
  "sourceIdentity",
  "status",
  "presentedDocumentRevision",
  "presentedSoftwareMapRevision",
] as const;

export type GuardedReviewField = (typeof GUARDED_REVIEW_FIELDS)[number];

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

export function reviewBusyResponse(
  error: ReviewBusyError,
): ReviewErrorResponse {
  return {
    ok: false,
    code: "review_busy",
    retryable: true,
    error: error.message,
  };
}

export function reviewMutationFingerprint<
  Review extends Pick<StoredReviewRecord, GuardedReviewField>,
>(record: Review): string {
  return fingerprintGuardedValues(record);
}

function fingerprintGuardedValues(
  values: JsonObject | Partial<Pick<StoredReviewRecord, GuardedReviewField>>,
): string {
  const digest = createHash("sha256");
  for (const field of GUARDED_REVIEW_FIELDS) {
    digest.update(`${field}\0`);
    digest.update(field in values ? stableJson(values[field]) : "\0absent");
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Key-order independent, so a rewritten record with reordered
 * `sourceIdentity` keys still compares equal, as deep equality did. */
function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return "\0undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isJsonObject(value)) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

/** Call under the mutation lock before writing a candidate prepared earlier. */
export async function assertReviewUnchanged(
  reviewDir: string,
  expected: Pick<StoredReviewRecord, GuardedReviewField>,
): Promise<void> {
  const actual = jsonObject(
    parseJsonText(await readFile(path.join(reviewDir, "review.json"), "utf8")),
  );
  if (
    fingerprintGuardedValues(actual ?? {}) !==
    reviewMutationFingerprint(expected)
  )
    throw new Error(
      "Review changed while preparing publication; rerun the publish command.",
    );
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
