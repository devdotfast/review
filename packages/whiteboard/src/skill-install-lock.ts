import os from "node:os";
import path from "node:path";

import { withFileLock } from "@dev.fast/trace-core";

/** Shared by terminal installs, Desktop updates, and removals, across processes. */
export async function withSkillInstallLock<T>(
  homeDir: string = os.homedir(),
  operation: () => Promise<T>,
): Promise<T> {
  const outcome = await withFileLock(
    path.join(homeDir, ".dev", "skill-install.lock"),
    { retryMs: 50, timeoutMs: 30_000, staleMs: 300_000, unownedGraceMs: 5_000 },
    operation,
  );

  if (!outcome.acquired)
    throw new Error(
      "Another Whiteboard skill installation is running. Retry shortly.",
    );

  return outcome.result;
}
