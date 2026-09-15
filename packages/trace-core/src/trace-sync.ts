import { commitShaSchema, sessionIdSchema } from "@dev.fast/trace-protocol";

import { readRepoMetaFields, readSubjectPullNumber } from "./trace-corpus";
import { findLocalTrace } from "./trace-local-sessions";
import { storageFor } from "./trace-read";
import { inferRepoFromGit, parseRepo } from "./trace-repo";
import { resolveTraceStorage } from "./trace-storage/resolve";
import {
  type HostedPublishDetails,
  type TraceStorage,
} from "./trace-storage/types";

export interface ReviewTraceSyncUpload {
  blob: string;
  bytes_stored: number;
  status: "uploaded" | "unchanged";
}

export interface ReviewTraceSyncResult {
  session: string;
  repo: string;
  uploads: ReviewTraceSyncUpload[];
  /** Present after a hosted publication. */
  hosted?: HostedPublishDetails;
}

/** Publishes the discovered local transcript and subagents through the selected store, preserving its consent and provenance checks. */
export async function syncReviewTrace(input: {
  sessionId: string;
  cwd?: string;
  repo?: string;
  commits?: string[];
  storage?: TraceStorage | null;
}): Promise<ReviewTraceSyncResult> {
  const sessionId = input.sessionId.trim();

  if (!sessionIdSchema.safeParse(sessionId).success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }

  const workDir = input.cwd ?? process.cwd();

  const storage =
    input.storage === undefined
      ? await resolveTraceStorage({ cwd: workDir, purpose: "write" })
      : input.storage;

  if (!storage) {
    throw new Error(
      "S3/R2 storage is not configured. Use Review Agent Setup to configure trace capture.",
    );
  }

  const repo = input.repo
    ? parseRepo(input.repo)
    : await inferRepoFromGit(workDir);

  const local = await findLocalTrace(sessionId);

  if (!local) {
    throw new Error(`No local trace found for session ${sessionId}.`);
  }

  const { author, branch } = await readRepoMetaFields(workDir);

  // A hosted publication settles consent and provenance before it reads a
  // transcript; s3 publication has no such gate.
  const published = await storage.publish({
    sessionId,
    cwd: workDir,
    repo,
    harness: local.harness,
    files: [
      { name: "main", path: local.tracePath },
      ...local.subagentPaths.map((sub) => ({ name: sub.name, path: sub.path })),
    ],
    commits: input.commits,
    branch,
    author,
  });

  const result: ReviewTraceSyncResult = {
    session: sessionId,
    repo: `${repo.owner}/${repo.repo}`,
    uploads: published.uploads,
  };

  if (published.hosted) result.hosted = published.hosted;

  return result;
}

/** Validates a commit and associates its sessions through the selected store, failing when storage is absent. */
export async function writeReviewTraceCommitMapping(input: {
  cwd: string;
  commit: string;
  sessions: string[];
  branch: string | null;
  storage?: TraceStorage | null;
}): Promise<boolean> {
  const commit = commitShaSchema.parse(input.commit);
  const storage = await storageFor(input.storage, input.cwd);

  if (!storage) {
    throw new Error(`Failed to write by-commit/${commit}.json.`);
  }

  return storage.associateCommits({
    commit,
    sessions: input.sessions,
    branch: input.branch,
    resolve: async () => ({
      repo: await inferRepoFromGit(input.cwd),
      pr: await readSubjectPullNumber(input.cwd, commit),
    }),
  });
}
