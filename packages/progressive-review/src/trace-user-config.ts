// Per-user repository consent for the hosted trace store.
//
// A user allows a repository once with `review trace allow`, and every hosted
// upload path reads the entry back before it sends anything. Entries live in
// the shared trace config under `repositories`, each naming the hosted
// origins it may publish to. Consent never selects a store by itself.

import { devReviewHome } from "./review-storage";
import { normalizeStoreOrigin } from "./store-origin";
import type { TraceRepositoryEntry as ConfigEntry } from "./trace-storage/config";
import {
  TRACE_CONFIG_VERSION,
  TraceConfigurationError,
  emptyTraceConfig,
  enabledOriginsOf,
  readTraceConfigFile,
  traceConfigPath,
  writeTraceConfigFile,
} from "./trace-storage/config";

/** One consent with its origins resolved (the default when none is written). */
export interface TraceRepositoryEntry {
  repositoryId: number;
  name: string;
  enabledOrigins: string[];
  allowedAt: string | null;
}

export interface TraceUserConfig {
  version: typeof TRACE_CONFIG_VERSION;
  repositories: TraceRepositoryEntry[];
}

export function traceUserConfigPath(devHome = devReviewHome()): string {
  return traceConfigPath({ devHome });
}

export async function readTraceUserConfig(
  devHome?: string,
): Promise<TraceUserConfig> {
  const file = readTraceConfigFile({ devHome: devHome ?? devReviewHome() });
  if (file.error) throw new TraceConfigurationError(file.error);
  const repositories = (file.config?.repositories ?? []).map((entry) => ({
    repositoryId: entry.repositoryId,
    name: entry.name,
    // An origin that is not a bare origin grants nothing: no upload can
    // name that destination.
    enabledOrigins: enabledOriginsOf(entry).flatMap((origin) => {
      try {
        return [normalizeStoreOrigin(origin)];
      } catch {
        return [];
      }
    }),
    allowedAt: entry.allowedAt ?? null,
  }));
  return { version: TRACE_CONFIG_VERSION, repositories };
}

async function writeRepositories(
  devHome: string,
  repositories: ConfigEntry[],
): Promise<void> {
  const file = readTraceConfigFile({ devHome });
  if (file.error) throw new TraceConfigurationError(file.error);
  await writeTraceConfigFile(file, {
    ...(file.config ?? emptyTraceConfig()),
    repositories,
  });
}

function toConfigEntry(entry: TraceRepositoryEntry): ConfigEntry {
  const written: ConfigEntry = {
    repositoryId: entry.repositoryId,
    name: entry.name,
    enabledOrigins: entry.enabledOrigins,
  };
  if (entry.allowedAt) written.allowedAt = entry.allowedAt;
  return written;
}

/**
 * Allows one repository at one origin. A repository has one entry, keyed by
 * its immutable id; allowing it at another origin appends to its list, and
 * a rename updates the display name.
 */
export async function allowTraceRepository(
  entry: { repositoryId: number; name: string; origin: string },
  devHome = devReviewHome(),
): Promise<TraceUserConfig> {
  const origin = normalizeStoreOrigin(entry.origin);
  if (!Number.isSafeInteger(entry.repositoryId) || entry.repositoryId < 1) {
    throw new Error("The trace repository id must be a positive integer.");
  }
  const config = await readTraceUserConfig(devHome);
  const existing = config.repositories.find(
    (candidate) => candidate.repositoryId === entry.repositoryId,
  );
  const merged: TraceRepositoryEntry = {
    repositoryId: entry.repositoryId,
    name: entry.name,
    enabledOrigins: [...new Set([...(existing?.enabledOrigins ?? []), origin])],
    allowedAt: existing?.allowedAt ?? new Date().toISOString(),
  };
  const repositories = [
    ...config.repositories.filter(
      (candidate) =>
        candidate.repositoryId !== entry.repositoryId &&
        candidate.name.toLowerCase() !== entry.name.toLowerCase(),
    ),
    merged,
  ];
  await writeRepositories(devHome, repositories.map(toConfigEntry));
  return { version: TRACE_CONFIG_VERSION, repositories };
}

/** Withdraws consent for a repository at every origin. */
export async function denyTraceRepository(
  name: string,
  devHome = devReviewHome(),
): Promise<boolean> {
  const config = await readTraceUserConfig(devHome);
  const repositories = config.repositories.filter(
    (existing) => existing.name.toLowerCase() !== name.toLowerCase(),
  );
  const removed = repositories.length !== config.repositories.length;
  if (removed)
    await writeRepositories(devHome, repositories.map(toConfigEntry));
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
