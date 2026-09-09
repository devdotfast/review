import { DirectTraceStorage } from "./direct";
import { type DirectConfigScope, clearTraceEnvCache } from "./direct-config";
import type { TraceStorage } from "./types";

/**
 * Selects the remote trace store for this machine. Today the only
 * selection is the legacy direct bucket configuration; without it there is
 * no remote storage and ordinary Review keeps working.
 */
export async function resolveTraceStorage(
  scope: DirectConfigScope = {},
): Promise<TraceStorage | null> {
  return DirectTraceStorage.fromEnvironment(scope);
}

export function isTraceStorageConfigured(
  scope: DirectConfigScope = {},
): boolean {
  return DirectTraceStorage.fromEnvironment(scope) !== null;
}

export { clearTraceEnvCache };
