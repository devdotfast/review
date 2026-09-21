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
