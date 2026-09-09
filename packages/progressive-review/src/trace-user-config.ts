// Per-user repository consent for the hosted trace store.
//
// A user allows a repository once with `review trace allow`, and every hosted
// upload path reads the entry back before it sends anything. Entries live in
// the shared version-2 trace config next to the storage selection; they are
// consent records bound to one origin and one immutable repository id, never
// routing rules, and they never select hosted storage by themselves.

import { devReviewHome } from "./review-storage";
import { normalizeStoreOrigin } from "./store-origin";
import type { TraceRepositoryEntry as ConfigRepositoryEntry } from "./trace-storage/config";
import {
  TRACE_CONFIG_VERSION,
  TraceConfigurationError,
  readTraceConfigFile,
  traceConfigPath,
  writeTraceConfigFile,
} from "./trace-storage/config";

export interface TraceRepositoryEntry {
  repositoryId: number;
  name: string;
  store: string;
  allowedAt: string;
}

export interface TraceUserConfig {
  version: typeof TRACE_CONFIG_VERSION;
  repositories: TraceRepositoryEntry[];
}

export function traceUserConfigPath(devHome = devReviewHome()): string {
  return traceConfigPath({ devHome });
}

/** The consent entries, dropping any whose store is not a bare origin. */
export async function readTraceUserConfig(
  devHome?: string,
): Promise<TraceUserConfig> {
  const file = readTraceConfigFile({ devHome: devHome ?? devReviewHome() });
  if (file.error) throw new TraceConfigurationError(file.error);
  const repositories = (file.config?.repositories ?? []).flatMap((entry) =>
    consentEntry(entry),
  );
  return { version: TRACE_CONFIG_VERSION, repositories };
}

function consentEntry(entry: ConfigRepositoryEntry): TraceRepositoryEntry[] {
  if (!entry.allowedAt) return [];
  try {
    return [
      {
        ...entry,
        store: normalizeStoreOrigin(entry.store),
        allowedAt: entry.allowedAt,
      },
    ];
  } catch {
    // An entry whose store is not a bare origin grants nothing: no upload
    // can name that destination.
    return [];
  }
}

async function writeRepositories(
  devHome: string,
  repositories: TraceRepositoryEntry[],
): Promise<void> {
  const file = readTraceConfigFile({ devHome });
  if (file.error) throw new TraceConfigurationError(file.error);
  await writeTraceConfigFile(file, {
    ...(file.config ?? { version: TRACE_CONFIG_VERSION }),
    repositories,
  });
}

export async function allowTraceRepository(
  entry: Omit<TraceRepositoryEntry, "allowedAt">,
  devHome = devReviewHome(),
): Promise<TraceUserConfig> {
  const store = normalizeStoreOrigin(entry.store);
  if (!Number.isSafeInteger(entry.repositoryId) || entry.repositoryId < 1) {
    throw new Error("The trace repository id must be a positive integer.");
  }
  const config = await readTraceUserConfig(devHome);
  // One entry per repository at one store, and one entry per name: a new
  // allow replaces the entry it supersedes instead of adding a twin.
  const repositories = [
    ...config.repositories.filter(
      (existing) =>
        existing.name.toLowerCase() !== entry.name.toLowerCase() &&
        !(
          existing.repositoryId === entry.repositoryId &&
          existing.store === store
        ),
    ),
    { ...entry, store, allowedAt: new Date().toISOString() },
  ];
  await writeRepositories(devHome, repositories);
  return { version: TRACE_CONFIG_VERSION, repositories };
}

export async function denyTraceRepository(
  name: string,
  devHome = devReviewHome(),
): Promise<boolean> {
  const config = await readTraceUserConfig(devHome);
  const repositories = config.repositories.filter(
    (existing) => existing.name.toLowerCase() !== name.toLowerCase(),
  );
  const removed = repositories.length !== config.repositories.length;
  if (removed) await writeRepositories(devHome, repositories);
  return removed;
}

export function findTraceRepository(
  config: TraceUserConfig,
  name: string,
): TraceRepositoryEntry | null {
  return (
    config.repositories.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    ) ?? null
  );
}
