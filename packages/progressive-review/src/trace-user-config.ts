// Per-user trace repository allowlist for the hosted trace store.
//
// A user allows a repository once (via `review trace allow`, not yet built)
// and every trace-upload path reads this file back to confirm the repository
// is still allowed before it uploads anything.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

export interface TraceRepositoryEntry {
  repositoryId: number;
  name: string;
  store: string;
  allowedAt: string;
}

export interface TraceUserConfig {
  version: 1;
  repositories: TraceRepositoryEntry[];
}

const DEFAULT_CONFIG: TraceUserConfig = { version: 1, repositories: [] };

export function traceUserConfigPath(devHome = devReviewHome()): string {
  return path.join(devHome, "trace", "config.json");
}

export async function readTraceUserConfig(
  devHome?: string,
): Promise<TraceUserConfig> {
  const filePath = traceUserConfigPath(devHome);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as TraceUserConfig;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported trace config version ${parsed.version} at ${filePath}.`,
    );
  }
  return parsed;
}

export async function allowTraceRepository(
  entry: Omit<TraceRepositoryEntry, "allowedAt">,
  devHome?: string,
): Promise<TraceUserConfig> {
  const config = await readTraceUserConfig(devHome);
  const next: TraceUserConfig = {
    version: 1,
    repositories: [
      ...config.repositories.filter(
        (existing) => existing.name.toLowerCase() !== entry.name.toLowerCase(),
      ),
      { ...entry, allowedAt: new Date().toISOString() },
    ],
  };
  await writePrivateJsonAtomic(traceUserConfigPath(devHome), next);
  return next;
}

export async function denyTraceRepository(
  name: string,
  devHome?: string,
): Promise<boolean> {
  const config = await readTraceUserConfig(devHome);
  const repositories = config.repositories.filter(
    (existing) => existing.name.toLowerCase() !== name.toLowerCase(),
  );
  const removed = repositories.length !== config.repositories.length;
  if (removed) {
    await writePrivateJsonAtomic(traceUserConfigPath(devHome), {
      version: 1,
      repositories,
    });
  }
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
