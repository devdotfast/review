// Failure records of background trace syncs.
//
// The SessionEnd hook runs `review trace sync` detached, with no terminal.
// A failure there would vanish, so the command writes one small record per
// session that `review trace status` lists with a retry command. A later
// successful sync removes it. The record holds no trace content and no URL.

import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { sessionIdSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";

const MAX_ERROR_LENGTH = 300;

const syncFailureSchema = z.object({
  session: z.string(),
  repository: z.string().nullable(),
  status: z.literal("failed"),
  error: z.string(),
  at: z.string(),
  retry: z.string(),
});

export type TraceSyncFailure = z.infer<typeof syncFailureSchema>;

export function traceSyncStatusDir(devHome = devReviewHome()): string {
  return path.join(devHome, "trace", "sync-status");
}

function statusPath(sessionId: string, devHome: string): string {
  return path.join(
    traceSyncStatusDir(devHome),
    `${sessionIdSchema.parse(sessionId)}.json`,
  );
}

/** Strips URLs and credentials from a message and caps its length. */
export function sanitizeTraceSyncError(message: string): string {
  const cleaned = message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/Bearer \S+/g, "Bearer <token>")
    .replace(/X-Amz-\S+/g, "<signature>")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_ERROR_LENGTH
    ? `${cleaned.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : cleaned;
}

export async function recordTraceSyncFailure(input: {
  sessionId: string;
  repository: string | null;
  error: string;
  devHome?: string;
}): Promise<void> {
  if (!sessionIdSchema.safeParse(input.sessionId).success) return;
  const record: TraceSyncFailure = {
    session: input.sessionId,
    repository: input.repository,
    status: "failed",
    error: sanitizeTraceSyncError(input.error),
    at: new Date().toISOString(),
    retry: `review trace sync ${input.sessionId}`,
  };
  await writePrivateJsonAtomic(
    statusPath(input.sessionId, input.devHome ?? devReviewHome()),
    record,
  );
}

export async function clearTraceSyncFailure(
  sessionId: string,
  devHome?: string,
): Promise<void> {
  if (!sessionIdSchema.safeParse(sessionId).success) return;
  await rm(statusPath(sessionId, devHome ?? devReviewHome()), { force: true });
}

export async function listTraceSyncFailures(
  devHome?: string,
): Promise<TraceSyncFailure[]> {
  const dir = traceSyncStatusDir(devHome ?? devReviewHome());
  const files = await readdir(dir).catch(() => []);
  const failures: TraceSyncFailure[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = syncFailureSchema.safeParse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (parsed.success) failures.push(parsed.data);
    } catch {
      // A partial file is not a record.
    }
  }
  return failures;
}
