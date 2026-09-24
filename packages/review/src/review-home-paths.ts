import crypto from "node:crypto";
import path from "node:path";

import { devReviewHome } from "@dev.fast/trace-core";

export { DEV_REVIEW_HOME_ENV, devReviewHome } from "@dev.fast/trace-core";

/** Return the repository-specific storage root under the shared Review home. */
export function reviewRepoStorageRoot(rootPath: string): string {
  return path.join(devReviewHome(), "repos", hashedSegment(rootPath, "repo"));
}

/** `<basename>-<12 hex>` of a resolved path, one safe storage segment. */
function hashedSegment(target: string, fallback: string): string {
  const resolved = path.resolve(target);
  const basename = safeStorageSegment(path.basename(resolved) || fallback);

  const hash = crypto
    .createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, 12);

  return `${basename}-${hash}`;
}

/** Encode a value as one filesystem-safe storage path segment. */
export function safeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "__");
}

export function reviewDesktopRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(devReviewHome(env), "review-desktop");
}

/** Written by Desktops that predate instance selection. */
export function reviewLegacyDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "server.json");
}

export function reviewInstancesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "instances");
}

export function reviewInstanceDiscoveryPath(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewInstancesDir(env), `${key}.json`);
}

export function reviewDefaultInstancePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "default-instance");
}

/** `dev-<name>-<hash>` for a source checkout, keyed like reviewRepoStorageRoot. */
export function reviewDevInstanceKey(checkout: string): string {
  return `dev-${hashedSegment(checkout, "checkout")}`;
}

export function reviewDesktopStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "state");
}
