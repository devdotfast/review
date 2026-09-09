// Per-user repository consent for the hosted trace store.
//
// A user allows a repository once with `review trace allow`, and every hosted
// upload path reads the entry back before it sends anything. Entries live in
// the shared trace config under `repositories`, each naming the hosted
// origins it may publish to. Consent never selects a store by itself.

import { devReviewHome } from "./review-storage";
import { normalizeStoreOrigin } from "./store-origin";
import type {
  TraceRepositoryEntry as ConfigEntry,
  TraceConfigFile,
} from "./trace-storage/config";
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
  return (await readTraceUserConfigFile(devHome)).consent;
}

/** The consent entries together with the file read they came from. */
async function readTraceUserConfigFile(
  devHome?: string,
): Promise<{ file: TraceConfigFile; consent: TraceUserConfig }> {
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
  return { file, consent: { version: TRACE_CONFIG_VERSION, repositories } };
}

// The write goes against the very read it was computed from, so two
// concurrent allow/deny runs cannot silently drop each other's change.
async function writeRepositories(
  file: TraceConfigFile,
  repositories: ConfigEntry[],
): Promise<void> {
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
  const { file, consent: config } = await readTraceUserConfigFile(devHome);
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
  await writeRepositories(file, repositories.map(toConfigEntry));
  return { version: TRACE_CONFIG_VERSION, repositories };
}

/**
 * Withdraws consent for a repository at every origin. The immutable id
 * catches an entry whose display name moved; the name catches one whose id
 * this machine never learned.
 */
export async function denyTraceRepository(
  repository: { name: string; repositoryId?: number | null },
  devHome = devReviewHome(),
): Promise<boolean> {
  const { file, consent: config } = await readTraceUserConfigFile(devHome);
  const repositories = config.repositories.filter(
    (existing) =>
      existing.name.toLowerCase() !== repository.name.toLowerCase() &&
      (repository.repositoryId == null ||
        existing.repositoryId !== repository.repositoryId),
  );
  const removed = repositories.length !== config.repositories.length;
  if (removed) await writeRepositories(file, repositories.map(toConfigEntry));
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
