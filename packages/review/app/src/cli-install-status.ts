import type { ReviewCliInstallStatus } from "@dev.fast/review-protocol";

export function cliInstallReady(status?: ReviewCliInstallStatus): boolean {
  return (
    !!status?.shim.installed &&
    (status.shim.onPath || status.shim.profileConfigured)
  );
}
