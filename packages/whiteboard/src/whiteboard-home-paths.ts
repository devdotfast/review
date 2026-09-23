import crypto from "node:crypto";
import path from "node:path";

import { devWhiteboardHome } from "@dev.fast/trace-core";

export {
  DEV_WHITEBOARD_HOME_ENV,
  devWhiteboardHome,
} from "@dev.fast/trace-core";

/** Return the repository-specific storage root under the shared Review home. */
export function whiteboardRepoStorageRoot(rootPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const basename = safeStorageSegment(path.basename(resolvedRoot) || "repo");

  const hash = crypto
    .createHash("sha256")
    .update(resolvedRoot)
    .digest("hex")
    .slice(0, 12);

  return path.join(devWhiteboardHome(), "repos", `${basename}-${hash}`);
}

/** Encode a value as one filesystem-safe storage path segment. */
export function safeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "__");
}

export function whiteboardDesktopRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(devWhiteboardHome(env), "review-desktop");
}

export function whiteboardDesktopDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(whiteboardDesktopRoot(env), "server.json");
}

export function whiteboardDesktopStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(whiteboardDesktopRoot(env), "state");
}
