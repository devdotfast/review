// Where an agent session ran.
//
// The agent hooks record, for each session id, the identity of every checkout
// the session touched. A sync publishes a session only when exactly one
// record exists and it names the allowed target. A commit trailer alone can
// never authorize a publication: trailers are copied by cherry-picks and can
// be written by hand.

import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { sessionIdSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import {
  type TraceRepositoryTarget,
  traceTargetKey,
} from "./trace-repository-target";

/** Records older than this are pruned when a new record is written. */
const PROVENANCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const provenanceRecordSchema = z.object({
  identity: z.string().min(1),
  allowed: z.boolean(),
  recordedAt: z.string(),
});

export type TraceSessionProvenanceRecord = z.infer<
  typeof provenanceRecordSchema
>;

/** The place one hook run identified, before the time it was recorded. */
export type TraceCaptureIdentity = Pick<
  TraceSessionProvenanceRecord,
  "identity" | "allowed"
>;

export function capturedSessionsDir(devHome = devReviewHome()): string {
  return path.join(devHome, "trace", "captured-sessions");
}

function sessionDir(sessionId: string, devHome: string): string {
  return path.join(
    capturedSessionsDir(devHome),
    sessionIdSchema.parse(sessionId),
  );
}

/**
 * The identity of one checkout for provenance. An allowed checkout is its
 * target key, so sibling worktrees of one repository count as one place. An
 * unallowed checkout is named by its repository, or by its Git directory
 * when it has no GitHub remote.
 */
export function traceCaptureIdentity(
  input:
    | { target: Pick<TraceRepositoryTarget, "origin" | "repositoryId"> }
    | { repositoryName: string }
    | { gitDir: string },
): TraceCaptureIdentity {
  if ("target" in input) {
    return { identity: traceTargetKey(input.target), allowed: true };
  }
  if ("repositoryName" in input) {
    return {
      identity: `unallowed:${input.repositoryName.toLowerCase()}`,
      allowed: false,
    };
  }
  return { identity: `unallowed:${input.gitDir}`, allowed: false };
}

/**
 * Writes the record for one session and identity when it does not exist
 * yet. Heartbeats call this often, so an existing record costs one stat.
 */
export async function recordTraceSessionProvenance(input: {
  sessionId: string;
  identity: string;
  allowed: boolean;
  devHome?: string;
}): Promise<void> {
  const devHome = input.devHome ?? devReviewHome();
  const fileName = `${createHash("sha256").update(input.identity).digest("hex")}.json`;
  const filePath = path.join(sessionDir(input.sessionId, devHome), fileName);
  if (
    await stat(filePath).then(
      () => true,
      () => false,
    )
  )
    return;
  const record: TraceSessionProvenanceRecord = {
    identity: input.identity,
    allowed: input.allowed,
    recordedAt: new Date().toISOString(),
  };
  await writePrivateJsonAtomic(filePath, record);
  await pruneStaleProvenance(devHome).catch(() => undefined);
}

async function pruneStaleProvenance(devHome: string): Promise<void> {
  const root = capturedSessionsDir(devHome);
  const cutoff = Date.now() - PROVENANCE_RETENTION_MS;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const info = await stat(dir).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Every record the hooks wrote for one session. */
export async function readTraceSessionProvenance(
  sessionId: string,
  devHome?: string,
): Promise<TraceSessionProvenanceRecord[]> {
  const dir = sessionDir(sessionId, devHome ?? devReviewHome());
  const files = await readdir(dir).catch(() => []);
  const records: TraceSessionProvenanceRecord[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = provenanceRecordSchema.safeParse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A partial or foreign file is not a record.
    }
  }
  return records;
}

/**
 * Throws unless the hooks saw this session in exactly one place, and that
 * place is the allowed target.
 */
export async function requireTraceSessionProvenance(
  sessionId: string,
  target: TraceRepositoryTarget,
  devHome?: string,
): Promise<void> {
  const records = await readTraceSessionProvenance(sessionId, devHome);
  if (records.length === 0) {
    throw new Error(
      `Review did not capture this session in ${target.name}. Start a new agent session there after \`review trace allow .\`; a commit trailer does not authorize publication.`,
    );
  }
  // A record of the same repository from before the user allowed it is the
  // same place: the user can run `review trace allow .` inside a session.
  const expected = traceTargetKey(target);
  const samePlace = `unallowed:${target.name.toLowerCase()}`;
  const matches =
    records.some((record) => record.allowed && record.identity === expected) &&
    records.every(
      (record) => record.identity === expected || record.identity === samePlace,
    );
  if (!matches) {
    throw new Error(
      `This session also ran in a repository that is not allowed for ${target.name}, so Review does not publish it automatically.`,
    );
  }
}
