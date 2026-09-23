/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The last segment of a path — how Review labels a worktree. */
export function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) || value;
}
