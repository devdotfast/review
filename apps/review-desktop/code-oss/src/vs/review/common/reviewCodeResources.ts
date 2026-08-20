/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUri } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import type {
  ReviewDiffSide,
  ReviewOpenEditorWire,
} from "./reviewProtocol.js";

export const REVIEW_BASE_SCHEME = "devfast-review-base";
export const REVIEW_HEAD_SCHEME = "devfast-review-head";
export const REVIEW_UNIFIED_SCHEME = "devfast-review-unified";

export interface ReviewResourceSession {
  readonly session: {
    readonly rootPath: string;
    readonly baseRootPath?: string;
    readonly headRootPath?: string;
  };
}

export interface ReviewResourceIdentitySession extends ReviewResourceSession {
  readonly session: ReviewResourceSession["session"] & {
    readonly sessionId: string;
  };
}

export function reviewVirtualUri(
  side: ReviewDiffSide,
  displayPath: string,
  canonicalPath: string,
  cacheKey: string,
  commit?: string,
): URI {
  const scheme = side === "base" ? REVIEW_BASE_SCHEME : REVIEW_HEAD_SCHEME;
  const query = new URLSearchParams({ path: canonicalPath, version: cacheKey });
  if (commit) query.set("commit", commit);
  return URI.from({ scheme, path: `/${displayPath}`, query: query.toString() });
}

export function reviewFileUri(
  session: ReviewResourceSession,
  filePath: string,
): URI {
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.split("/").includes("..")
  ) {
    throw new Error(`File path escapes the review repository: ${filePath}`);
  }
  return URI.joinPath(
    URI.file(session.session.rootPath),
    ...filePath.split("/"),
  );
}

export function reviewHeadFileUri(
  session: ReviewResourceSession,
  filePath: string,
): URI | undefined {
  const headRootPath = session.session.headRootPath;
  if (!headRootPath) return undefined;
  return reviewFileUri({ session: { rootPath: headRootPath } }, filePath);
}

export function reviewBaseFileUri(
  session: ReviewResourceSession,
  filePath: string,
): URI | undefined {
  const baseRootPath = session.session.baseRootPath;
  if (!baseRootPath) return undefined;
  return reviewFileUri({ session: { rootPath: baseRootPath } }, filePath);
}

export function reviewResourceIdentity(
  session: ReviewResourceIdentitySession,
  resource: URI,
): ReviewOpenEditorWire | null {
  if (
    resource.scheme === REVIEW_BASE_SCHEME ||
    resource.scheme === REVIEW_HEAD_SCHEME
  ) {
    const query = new URLSearchParams(resource.query);
    if (query.get("version") !== session.session.sessionId) return null;
    const filePath = query.get("path");
    return filePath ? { path: filePath, scheme: resource.scheme } : null;
  }
  if (resource.scheme !== "file") return null;

  const roots = [
    session.session.headRootPath,
    session.session.baseRootPath,
    session.session.rootPath,
  ];
  for (const rootPath of roots) {
    if (!rootPath) continue;
    const relative = extUri.relativePath(URI.file(rootPath), resource);
    if (relative && !relative.startsWith("../")) {
      return { path: relative, scheme: "file" };
    }
  }
  return null;
}
