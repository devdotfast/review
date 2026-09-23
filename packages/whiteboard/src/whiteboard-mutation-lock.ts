import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

import { withFileLock } from "@dev.fast/trace-core";
import {
  type JsonValue,
  type WhiteboardErrorResponse,
  isJsonObject,
} from "@dev.fast/whiteboard-protocol";

import type { StoredWhiteboardRecord } from "./whiteboard-home";

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Pins, lifecycle and presentation pointers. A mount prepared against these
 * values may only be written while they still hold. */
export const GUARDED_WHITEBOARD_FIELDS = [
  "sourceCommit",
  "baseCommit",
  "baseRef",
  "worktreePath",
  "sourceIdentity",
  "status",
  "presentedDocumentRevision",
  "presentedSoftwareMapRevision",
] as const;

export type GuardedWhiteboardField = (typeof GUARDED_WHITEBOARD_FIELDS)[number];

export class WhiteboardBusyError extends Error {
  override readonly name = "WhiteboardBusyError";
  readonly code = "WHITEBOARD_BUSY";
  readonly retryable = true;
  readonly sessionId: string;

  constructor(whiteboardDir: string) {
    const sessionId = path.basename(whiteboardDir);
    super(
      `Review ${sessionId} is busy. Retry after its current operation completes.`,
    );
    this.sessionId = sessionId;
  }
}

export function whiteboardBusyResponse(
  error: WhiteboardBusyError,
): WhiteboardErrorResponse {
  return {
    ok: false,
    code: "review_busy",
    retryable: true,
    error: error.message,
  };
}

export function whiteboardMutationFingerprint<
  Review extends Pick<StoredWhiteboardRecord, GuardedWhiteboardField>,
>(record: Review): string {
  const digest = createHash("sha256");

  for (const field of GUARDED_WHITEBOARD_FIELDS) {
    digest.update(`${field}\0`);
    digest.update(stableJson(record[field]));
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

/** Shared by the desktop and migration CLI; stored outside the sealed tree. */
export async function withWhiteboardMutationLock<T>(
  whiteboardDir: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const canonicalDir = path.resolve(whiteboardDir);
  const inherited = heldLocks.getStore();

  if (inherited?.has(canonicalDir)) return operation();

  const outcome = await withFileLock(
    `${whiteboardDir}.mutation-lock`,
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

  if (!outcome.acquired) throw new WhiteboardBusyError(whiteboardDir);

  return outcome.result;
}
