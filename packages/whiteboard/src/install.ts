import path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallTarget = "claude" | "codex" | "cursor" | "opencode" | "pi";

export const ALL_INSTALL_TARGETS: InstallTarget[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
];

export function isInstallTarget(value: string): value is InstallTarget {
  return ALL_INSTALL_TARGETS.some((target) => target === value);
}

export function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
