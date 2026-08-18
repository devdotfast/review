/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import type { ReviewResourceSession } from "./reviewCodeResources.js";

export interface ReviewWorkspaceFolderTarget {
  readonly uri: URI;
  readonly name: string;
}

/**
 * The single workspace folder a review session roots language servers at.
 *
 * This mirrors `ReviewCodeResourceService.targetForSession`, which builds real
 * `file:` editor resources from `headRootPath` first and falls back to
 * `rootPath` only when there is no head checkout. The folder has to follow the
 * same precedence: root it anywhere else and the servers index a tree the
 * reviewed files are not in, which is what leaves them without diagnostics or
 * cross-file navigation.
 *
 * `label` is the review title, which the protocol allows to be empty, so the
 * folder name falls back to the directory basename.
 */
export function reviewWorkspaceFolder(
  session: ReviewResourceSession | null | undefined,
  label?: string,
): ReviewWorkspaceFolderTarget | undefined {
  const root = session?.session.headRootPath ?? session?.session.rootPath;
  if (!root) {
    return undefined;
  }
  const uri = URI.file(root);
  return { uri, name: label?.trim() || basename(uri) };
}
