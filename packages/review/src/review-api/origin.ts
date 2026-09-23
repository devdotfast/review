import { z } from "zod";

import type { Snapshot } from "./store.js";

export const pullRequestUrl = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/,
    "Use a canonical GitHub PR URL: https://github.com/owner/repository/pull/123.",
  )
  .refine(
    (url) => Number.isSafeInteger(Number(url.split("/").at(-1))),
    "PR number is too large.",
  );

/** One key per PR: GitHub owner and repository names are case-insensitive,
 * and the URL pattern admits only ASCII, so lowercasing is canonical. */
export function pullRequestKey(url: string): string {
  return url.toLowerCase();
}

/** Omission preserves identity; null detaches it without changing import metadata. */
export function setPullRequest(
  snapshot: Pick<Snapshot, "origin">,
  url: string | null | undefined,
) {
  if (url === undefined) return;

  if (url === null) {
    if (snapshot.origin) {
      delete snapshot.origin.pullRequestUrl;
      delete snapshot.origin.pullRequestNumber;
    }

    return;
  }

  snapshot.origin = {
    ...snapshot.origin,
    pullRequestUrl: url,
    pullRequestNumber: Number(url.split("/").at(-1)),
  };
}

/** The branch names a review's two sides came from. Labels only: the pins
 * stay the source of truth, and a name left out is forgotten. */
export function setBranchNames(
  snapshot: Pick<Snapshot, "origin">,
  names: { base?: string; head?: string },
) {
  if (!snapshot.origin && !names.base && !names.head) return;
  const origin = { ...snapshot.origin };
  delete origin.baseRef;
  delete origin.branch;

  if (names.base) origin.baseRef = names.base;

  if (names.head) origin.branch = names.head;

  if (Object.keys(origin).length) snapshot.origin = origin;
  else delete snapshot.origin;
}
