import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "./atomic-write";

export type TraceHookOwner = "review" | "dev-traces";

// Hooks and command files are per OS user, even when Desktop uses a profile.
function disabledPath(owner: TraceHookOwner, homeDir: string): string {
  return path.join(homeDir, ".config", "dev-trace", "hooks-disabled", owner);
}

export function traceHooksDisabled(
  owner: TraceHookOwner,
  homeDir: string,
): boolean {
  return existsSync(disabledPath(owner, homeDir));
}

export async function setTraceHooksDisabled(
  owner: TraceHookOwner,
  homeDir: string,
  disabled: boolean,
): Promise<void> {
  const file = disabledPath(owner, homeDir);

  if (disabled) {
    await writeFileAtomicAsync(file, "Explicitly uninstalled trace hooks.\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    await rm(file, { force: true });
  }
}

/** Desktop's installed command wins until its hooks are explicitly released. */
export function desktopTraceCommand(homeDir: string): string | null {
  if (traceHooksDisabled("review", homeDir)) return null;
  const file = path.join(homeDir, ".local", "bin", "review");

  try {
    return readFileSync(file, "utf8").includes("# Managed by Review Desktop")
      ? file
      : null;
  } catch {
    return null;
  }
}
