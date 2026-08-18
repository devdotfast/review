/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewDiffFileWire, ReviewDiffSide } from "./reviewProtocol.js";

export function reviewDiffFilesUrl(sessionUrl: string, routePath: string): URL {
  const url = new URL(
    `${sessionUrl.replace(/\/$/, "")}/__progressive-review/diff-files`,
  );
  if (routePath !== "/") url.searchParams.set("document", routePath);
  return url;
}

export function reviewDiffFileForReveal(
  files: readonly ReviewDiffFileWire[],
  requestedPath: string,
  side: ReviewDiffSide,
): ReviewDiffFileWire | undefined {
  const currentPathMatch = files.find((file) => file.path === requestedPath);
  if (currentPathMatch || side === "head") return currentPathMatch;
  return files.find((file) => file.previousPath === requestedPath);
}
