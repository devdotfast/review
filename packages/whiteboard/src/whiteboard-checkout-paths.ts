import path from "node:path";

import { devFastGitDir } from "./software-map-paths";
import { safeStorageSegment } from "./whiteboard-home-paths";

export type WhiteboardCheckoutRole = "head" | "base";

/** Root for legacy commit-owned Review checkouts. Migration removes it. */
export function legacyWhiteboardWorktreesDir(gitCommonDir: string): string {
  return path.join(devFastGitDir(gitCommonDir), "worktrees");
}

/**
 * Root for Review-owned checkouts. A Session UUID identifies one subtree.
 */
export function whiteboardManagedCheckoutsDir(gitCommonDir: string): string {
  return path.join(devFastGitDir(gitCommonDir), "reviews");
}

/** Return the checkout subtree owned by one Session UUID. */
export function whiteboardManagedCheckoutRoot(
  gitCommonDir: string,
  sessionId: string,
): string {
  return path.join(
    whiteboardManagedCheckoutsDir(gitCommonDir),
    safeStorageSegment(sessionId),
  );
}

/** A detached checkout owned by one Session revision and source role. */
export function whiteboardManagedCheckoutDir(
  gitCommonDir: string,
  sessionId: string,
  role: WhiteboardCheckoutRole,
  commit: string,
): string {
  return path.join(
    whiteboardManagedCheckoutRoot(gitCommonDir, sessionId),
    role,
    safeStorageSegment(commit),
  );
}
