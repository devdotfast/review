// One resolved trace target for a checkout.
//
// Every trace command resolves the checkout to one target before it reads a
// cache, checks consent, or uploads anything. The target carries the store
// origin, the immutable GitHub repository id, the store instance, and the
// display name, so consent, upload, cache, and result all name one thing.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveRepoContext } from "@dev.fast/local-vcs";
import { z } from "zod";

import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { StoreApiError, type StoreClient } from "./store-client";
import { normalizeStoreOrigin } from "./store-origin";
import { type TraceRepo, inferRepoFromGit, traceRepoName } from "./trace-repo";
import {
  type TraceRepositoryEntry,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

export type { TraceRepo } from "./trace-repo";
export { inferRepoFromGit, parseRepo, traceRepoName } from "./trace-repo";

export interface TraceRepositoryTarget {
  /** The normalized store origin. */
  origin: string;
  /** The immutable GitHub repository id. */
  repositoryId: number;
  /** The current store instance. A deleted and re-onboarded store gets a new one. */
  storeId: string;
  /** The display name the store reports, `owner/repo`. */
  name: string;
}

/**
 * The identity of one target on this machine: a short digest of the origin
 * and the repository id. Cache directories and provenance records use it,
 * so a rename keeps its cache and a second origin never shares one.
 */
export function traceTargetKey(
  target: Pick<TraceRepositoryTarget, "origin" | "repositoryId">,
): string {
  if (!Number.isSafeInteger(target.repositoryId) || target.repositoryId < 1) {
    throw new Error("The trace repository id must be a positive integer.");
  }
  const origin = normalizeStoreOrigin(target.origin);
  const digest = createHash("sha256").update(origin).digest("hex");
  return `${digest.slice(0, 16)}/r${target.repositoryId}`;
}

const cachedTargetSchema = z.object({
  origin: z.string(),
  repositoryId: z.number().int().positive(),
  storeId: z.string().regex(/^[0-9a-f]{32}$/),
  name: z.string().min(1),
  /** The checkout's own `owner/repo` at the time of the lookup. */
  checkout: z.string().min(1),
  savedAt: z.string(),
});

/** The shared Git directory of a checkout. Sibling worktrees share it. */
export async function gitCommonDirectory(cwd: string): Promise<string | null> {
  return (await resolveRepoContext(cwd).catch(() => null))?.commonDir ?? null;
}

async function cachedTargetPath(
  cwd: string,
  origin: string,
  devHome: string,
): Promise<string | null> {
  const commonDir = await gitCommonDirectory(cwd);
  if (!commonDir) return null;
  const key = createHash("sha256")
    .update(`${origin}\n${commonDir}`)
    .digest("hex");
  return path.join(devHome, "trace", "targets", `${key}.json`);
}

/**
 * Saves the target this checkout resolved to, so an offline read can reuse
 * the identity the store confirmed. Tests call it to stand in for a lookup.
 */
export async function rememberTraceRepositoryTarget(input: {
  cwd: string;
  target: TraceRepositoryTarget;
  checkout?: string;
  devHome?: string;
}): Promise<void> {
  const devHome = input.devHome ?? devReviewHome();
  const origin = normalizeStoreOrigin(input.target.origin);
  const filePath = await cachedTargetPath(input.cwd, origin, devHome);
  if (!filePath) return;
  await writePrivateJsonAtomic(filePath, {
    ...input.target,
    origin,
    checkout: input.checkout ?? input.target.name,
    savedAt: new Date().toISOString(),
  });
}

/**
 * The target this checkout resolved to on an earlier online lookup, or null
 * when none was saved or the saved one names another origin or repository.
 */
export async function readCachedTraceRepositoryTarget(input: {
  cwd: string;
  origin: string;
  devHome?: string;
}): Promise<TraceRepositoryTarget | null> {
  const devHome = input.devHome ?? devReviewHome();
  const origin = normalizeStoreOrigin(input.origin);
  const filePath = await cachedTargetPath(input.cwd, origin, devHome);
  if (!filePath) return null;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: z.infer<typeof cachedTargetSchema>;
  try {
    const result = cachedTargetSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const checkout = await inferRepoFromGit(input.cwd).catch(() => null);
  if (
    !checkout ||
    traceRepoName(checkout).toLowerCase() !== parsed.checkout.toLowerCase()
  ) {
    return null;
  }
  return {
    origin: parsed.origin,
    repositoryId: parsed.repositoryId,
    storeId: parsed.storeId,
    name: parsed.name,
  };
}

/** Whether a store failure means the store could not answer at all. */
export function isStoreUnreachable(error: Error): boolean {
  return !(error instanceof StoreApiError) || error.status >= 500;
}

/**
 * Resolves the checkout to its trace target through the store. A network
 * failure on a read (`write === false`) falls back to the saved target of
 * this checkout and reports `offline: true`. A write never falls back.
 */
export async function resolveTraceRepositoryTarget(input: {
  cwd: string;
  origin: string;
  client: StoreClient;
  write: boolean;
  devHome?: string;
}): Promise<{ target: TraceRepositoryTarget; offline: boolean }> {
  const origin = normalizeStoreOrigin(input.origin);
  const repo = await inferRepoFromGit(input.cwd);
  const checkout = traceRepoName(repo);
  let store: Awaited<ReturnType<StoreClient["findStore"]>>;
  try {
    store = await input.client.findStore({
      owner: repo.owner,
      name: repo.repo,
    });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (
      input.write ||
      !isStoreUnreachable(cause) ||
      (cause instanceof StoreApiError && cause.code === "store_deleted")
    ) {
      throw cause;
    }
    const cached = await readCachedTraceRepositoryTarget({
      cwd: input.cwd,
      origin,
      devHome: input.devHome,
    });
    if (!cached) throw cause;
    return { target: cached, offline: true };
  }
  if (!store) {
    throw new StoreApiError(
      "not_found",
      404,
      "This repository has no active hosted trace store. Run `review trace onboard`.",
    );
  }
  if (store.status !== "active") {
    throw new StoreApiError(
      "store_deleted",
      410,
      "This repository's trace store was deleted.",
    );
  }
  const target: TraceRepositoryTarget = {
    origin,
    repositoryId: store.repositoryId,
    storeId: store.storeId,
    name: store.displayName,
  };
  await rememberTraceRepositoryTarget({
    cwd: input.cwd,
    target,
    checkout,
    devHome: input.devHome,
  }).catch(() => undefined);
  return { target, offline: false };
}

/**
 * The consent entry that covers this target: the repository, allowed at the
 * target's origin. An entry allowed only elsewhere names where.
 */
export async function requireTraceConsent(
  target: TraceRepositoryTarget,
  devHome?: string,
): Promise<TraceRepositoryEntry> {
  const config = await readTraceUserConfig(devHome);
  const entry =
    config.repositories.find(
      (candidate) => candidate.repositoryId === target.repositoryId,
    ) ?? findTraceRepository(config, target.name);
  if (entry?.enabledOrigins.includes(target.origin)) return entry;
  if (entry) {
    throw new Error(
      `${entry.name} is allowed to publish traces to ${entry.enabledOrigins.join(", ")}, not ${target.origin}. Run \`review trace allow .\` while logged in there.`,
    );
  }
  throw new Error(
    "This repository is not allowed for trace publication. Run `review trace allow .`.",
  );
}
