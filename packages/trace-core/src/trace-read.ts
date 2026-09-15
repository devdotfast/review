import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitAt } from "@dev.fast/local-vcs";
import {
  type ReviewAgentTraceSession,
  type SessionMeta,
  sessionIdSchema,
} from "@dev.fast/trace-protocol";

import {
  AGENT_TRACE_PARSER_VERSION,
  type AgentTraceParseResult,
  extractTraceEventText,
  parseAgentTraceJsonl,
} from "./agent-trace-parser";
import {
  type CommitWithSessions,
  type NormalizedTrace,
  type ReviewTraceCommitRef,
  type ReviewTracePullResult,
  type ReviewTracePullSession,
  type ReviewTracePullSessionResult,
  type ReviewTraceSessionRef,
  commitsWithTrailers,
  deduplicateStrings,
  findNormalizedSessionDirs,
  findNormalizedTraceFile,
  legacyObjectKey,
  normalizeRepo,
  normalizedTracePath,
  prScanTrailerSessions,
  readNormalizedTrace,
  readSubjectPullNumber,
  readTrailerSessions,
  resolveCommitSha,
  subjectPullNumber,
  traceSearchCorpusDir,
  writeNormalizedTraceAtomic,
} from "./trace-corpus";
import { findLocalTrace } from "./trace-local-sessions";
import { inferRepoFromGit, parseRepo, traceRepoName } from "./trace-repo";
import { resolveTraceStorage } from "./trace-storage/resolve";
import { clearTraceEnvCache as clearS3EnvCache } from "./trace-storage/s3-config";
import {
  type TraceStorage,
  TraceStorageDeniedError,
  TraceStorageUnavailableError,
} from "./trace-storage/types";

const STORE_COMMIT_LOOKUP_LIMIT = 30;

const REMOTE_HEAD_TTL_MS = 15_000;

// Reserved sample ID: the tutorial works offline without trace capture setup.
export const TUTORIAL_TRACE_SESSION_ID = "review-tutorial-checkout";

export type ReviewTraceSessionDescriptor = ReviewAgentTraceSession;

/**
 * How fresh a loaded trace is: `current` when the store confirmed it,
 * `offline` when the store did not answer and a saved copy was served,
 * `stale` when the store answered but the download failed.
 */
export type TraceCacheStatus = "current" | "offline" | "stale";

export interface LoadedReviewAgentTrace {
  parserVersion: string;
  descriptor: ReviewTraceSessionDescriptor;
  trace: AgentTraceParseResult;
  subagents: string[];
  traceName: string | null;
  cacheStatus: TraceCacheStatus;
}

export type ReviewTraceLookupSource = "trailer" | "index" | "pr-scan" | "none";

export interface ReviewTraceCommitLookupResult {
  commit: string;
  sessions: string[];
  pr: number | null;
  branch: string | null;
  source: ReviewTraceLookupSource;
  session_meta?: Record<
    string,
    {
      repo?: string | null;
      branch?: string | null;
      pr?: number | null;
      author?: string | null;
    }
  >;
}

export interface ReviewTraceSessionLookupResult {
  session: string;
  meta: SessionMeta | null;
  has_raw_trace: boolean;
  subagents: string[];
}

export interface ReviewTraceBlameLookupResult {
  file: string;
  range: string | null;
  history: boolean;
  resolutions: ReviewTraceCommitLookupResult[];
}

const lastCheckedTimes = new Map<string, number>();

/**
 * The store to read from or publish to: an explicit override, or the
 * machine's selected store. Null means no remote storage is configured.
 */
export async function storageFor(
  storage: TraceStorage | null | undefined,
  cwd?: string,
): Promise<TraceStorage | null> {
  return storage === undefined ? resolveTraceStorage({ cwd }) : storage;
}

/**
 * A remote lookup, or null when the store could not be reached. A refusal
 * propagates: the caller must show nothing, not "nothing here".
 */
async function reachable<T>(lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup();
  } catch (error) {
    if (error instanceof TraceStorageUnavailableError) return null;
    throw error;
  }
}

function freshnessKey(
  storage: TraceStorage,
  sessionId: string,
  traceName: string,
): string {
  return `${storage.cacheIdentity()}/${sessionId}/${traceName}`;
}

/** Describes sessions for a change range using trailers, then bounded store-index and pull-request fallbacks when none are found. */
export async function listReviewTraceSessions(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
  storage?: TraceStorage | null;
}): Promise<ReviewTraceSessionDescriptor[]> {
  const storage = await storageFor(input.storage, input.rootPath);
  const sessions = new Map<string, ReviewTraceSessionRef>();
  const commits = await commitsWithTrailers(input);

  for (const commit of commits) {
    for (const sessionId of commit.sessions) {
      const existing = sessions.get(sessionId);

      if (existing) {
        existing.commits.push({ sha: commit.sha, subject: commit.subject });
      } else {
        sessions.set(sessionId, {
          sessionId,
          commits: [{ sha: commit.sha, subject: commit.subject }],
        });
      }
    }
  }

  if (sessions.size === 0 && commits.length <= STORE_COMMIT_LOOKUP_LIMIT) {
    await addSessionsFromStoreIndex(storage, commits, sessions);
  }

  if (sessions.size === 0 && commits.length <= STORE_COMMIT_LOOKUP_LIMIT) {
    await addSessionsFromPrScan(input.rootPath, commits, sessions);
  }

  const descriptors: ReviewTraceSessionDescriptor[] = [];

  for (const ref of sessions.values()) {
    const desc = await describeTraceSession(ref, storage);
    descriptors.push(desc);
  }

  return descriptors;
}

/** Describes availability from compatible local copies and the selected store; store refusals propagate. */
export async function describeTraceSession(
  ref: ReviewTraceSessionRef,
  storage?: TraceStorage | null,
): Promise<ReviewTraceSessionDescriptor> {
  const store = await storageFor(storage);
  const local = findNormalizedTraceFile(ref.sessionId, "main", store);
  const normalized = local ? readNormalizedTrace(local, store) : null;

  const remote = store
    ? await reachable(() => store.describeObject(ref.sessionId, "main"))
    : null;

  const available = normalized !== null || (remote !== null && remote.size > 0);
  const harness = normalized?.metadata.harness ?? "unknown";

  const subagents = await listSessionSubagents(ref.sessionId, store);

  return {
    sessionId: ref.sessionId,
    harness,
    available,
    source: available ? "r2" : null,
    notSynced: !available,
    subagents,
    commits: ref.commits,
  };
}

/** Loads the offline tutorial or a store-compatible normalized trace, preserving freshness and offline fallback status; store refusals propagate. */
export async function loadReviewAgentTrace(input: {
  sessionId: string;
  trace?: string;
  commits?: ReviewTraceCommitRef[];
  cwd?: string;
  repo?: string | { owner: string; repo: string };
  refresh?: boolean;
  storage?: TraceStorage | null;
}): Promise<LoadedReviewAgentTrace | null> {
  const { sessionId, trace } = input;

  if (sessionId === TUTORIAL_TRACE_SESSION_ID) {
    if (trace && trace !== "main") return null;
    const { loadTutorialTrace } = await import("./tutorial-trace");

    return loadTutorialTrace();
  }

  if (!sessionIdSchema.safeParse(sessionId).success) return null;
  const traceName = trace ?? "main";
  const storage = await storageFor(input.storage, input.cwd);
  const requestedRepo = input.repo ? normalizeRepo(input.repo) : null;

  let scope = storage ? storage.cacheScope(requestedRepo) : requestedRepo;

  let normalizedPath = scope
    ? normalizedTracePath(scope, sessionId, traceName)
    : findNormalizedTraceFile(sessionId, traceName, storage);

  let normalized = normalizedPath
    ? readNormalizedTrace(normalizedPath, storage)
    : null;

  const now = Date.now();
  const checkKey = storage ? freshnessKey(storage, sessionId, traceName) : null;
  const lastChecked = checkKey ? (lastCheckedTimes.get(checkKey) ?? 0) : 0;

  const canUseWithoutCheck =
    normalized && !input.refresh && now - lastChecked < REMOTE_HEAD_TTL_MS;

  if (storage && checkKey && !canUseWithoutCheck) {
    // A hosted refresh is current only after the whole read succeeds.
    if (storage.kind === "hosted") lastCheckedTimes.delete(checkKey);
    let remote: Awaited<ReturnType<TraceStorage["describeObject"]>>;

    try {
      remote = await storage.describeObject(sessionId, traceName);
    } catch (error) {
      // A refusal (forbidden, deleted) shows nothing: an old copy must not
      // pass as freshly authorized data.
      if (error instanceof TraceStorageDeniedError) return null;

      // The store did not answer: the saved copy, if any, is all there is.
      if (!(error instanceof TraceStorageUnavailableError)) throw error;

      return normalized
        ? loadedNormalizedTrace(normalized, input.commits, "offline")
        : null;
    }

    if (storage.kind === "hosted" && remote === null) {
      // A live manifest is authoritative. Remove only this store's copy so
      // later offline reads cannot revive an object the store removed.
      if (normalized && normalizedPath) rmSync(normalizedPath, { force: true });
      lastCheckedTimes.delete(checkKey);

      return null;
    }

    if (storage.kind !== "hosted") lastCheckedTimes.set(checkKey, now);

    const mustMaterialize =
      remote !== null &&
      (!normalized || !cacheIsCurrent(storage, normalized, remote));

    if (mustMaterialize) {
      if (!scope) {
        let repo = requestedRepo;

        if (!repo && input.cwd) {
          repo = await inferRepoFromGit(input.cwd).catch(() => null);
        }

        if (!repo) {
          const meta = await storage.sessionMeta(sessionId);

          if (meta?.repo) {
            try {
              repo = parseRepo(meta.repo);
            } catch {
              repo = null;
            }
          }
        }

        scope = storage.cacheScope(repo);
      }

      if (!scope) {
        // Nowhere to place a fresh copy; the saved one is all there is.
        return normalized
          ? loadedNormalizedTrace(normalized, input.commits, "stale")
          : null;
      }

      normalizedPath = normalizedTracePath(scope, sessionId, traceName);

      const fresh = await materializeNormalizedTrace({
        storage,
        sessionId,
        traceName,
        normalizedPath,
        repository: requestedRepo
          ? traceRepoName(requestedRepo)
          : (normalized?.metadata.repository ?? traceRepoName(scope)),
      });

      // A failed download leaves the last readable copy, marked stale.
      if (!fresh) {
        return normalized
          ? loadedNormalizedTrace(normalized, input.commits, "stale")
          : null;
      }

      normalized = fresh;
    }

    if (storage.kind === "hosted") lastCheckedTimes.set(checkKey, now);
  }

  if (!normalized) return null;

  return loadedNormalizedTrace(
    normalized,
    input.commits,
    storage?.kind === "hosted" && (await storage.readiness()).ready === false
      ? "offline"
      : "current",
  );
}

/**
 * Whether a saved copy still matches the stored object. S3 storage can
 * only compare sizes and objects only grow; hosted storage names content
 * exactly, so an equal-size or smaller replacement is still seen.
 */
function cacheIsCurrent(
  storage: TraceStorage,
  normalized: NormalizedTrace,
  remote: { size: number; contentId: string },
): boolean {
  if (storage.kind === "s3") {
    return remote.size <= normalized.metadata.source.bytes;
  }

  return normalized.metadata.source.contentId === remote.contentId;
}

function loadedNormalizedTrace(
  normalized: NormalizedTrace,
  commits: ReviewTraceCommitRef[] | undefined,
  cacheStatus: TraceCacheStatus,
): LoadedReviewAgentTrace {
  const metadata = normalized.metadata;

  const descriptor: ReviewTraceSessionDescriptor = {
    sessionId: metadata.session,
    harness: metadata.harness,
    available: true,
    source: "r2",
    subagents: metadata.subagents,
    commits: commits ?? [],
  };

  return {
    parserVersion: metadata.parserVersion,
    descriptor,
    trace: {
      harness: metadata.harness,
      title: metadata.title,
      events: normalized.events.map((record) => record.event),
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      activeMs: metadata.activeMs,
      userTurns: metadata.userTurns,
      toolCalls: metadata.toolCalls,
    },
    subagents: metadata.subagents,
    traceName: metadata.trace === "main" ? null : metadata.trace,
    cacheStatus,
  };
}

async function materializeNormalizedTrace(input: {
  storage: TraceStorage;
  sessionId: string;
  traceName: string;
  normalizedPath: string;
  repository: string;
}): Promise<NormalizedTrace | null> {
  const rawTempPath = path.join(
    tmpdir(),
    `review-trace-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );

  try {
    let downloaded: Awaited<ReturnType<TraceStorage["downloadObject"]>>;

    try {
      downloaded = await input.storage.downloadObject(
        input.sessionId,
        input.traceName,
        rawTempPath,
      );
    } catch (error) {
      // A refusal must not become a stale-cache response.
      if (error instanceof TraceStorageDeniedError) throw error;

      // A failed or corrupt transfer leaves no file and no cache change.
      if (error instanceof TraceStorageUnavailableError) return null;
      process.stderr.write(
        `Trace store download failed for ${input.traceName}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );

      return null;
    }

    if (!downloaded) return null;

    const parsed = parseAgentTraceJsonl(readFileSync(rawTempPath, "utf8"), {
      isSubagent: input.traceName !== "main",
    });

    const subagents = await listSessionSubagents(
      input.sessionId,
      input.storage,
    );

    const normalized: NormalizedTrace = {
      metadata: {
        type: "metadata",
        version: 1,
        parserVersion: AGENT_TRACE_PARSER_VERSION,
        repository: input.repository,
        session: input.sessionId,
        trace: input.traceName,
        harness: parsed.harness,
        title: parsed.title,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        activeMs: parsed.activeMs,
        userTurns: parsed.userTurns,
        toolCalls: parsed.toolCalls,
        subagents,
        source: {
          r2Key: legacyObjectKey(input.sessionId, input.traceName),
          bytes: downloaded.size,
          checkedAt: new Date().toISOString(),
          contentId: downloaded.contentId,
          storage: input.storage.cacheIdentity(),
        },
      },
      events: parsed.events.map((event, index) => ({
        type: "event",
        index,
        kind: event.kind,
        text: extractTraceEventText(event),
        event,
      })),
    };

    writeNormalizedTraceAtomic(input.normalizedPath, normalized);

    return normalized;
  } finally {
    rmSync(rawTempPath, { force: true });
  }
}

/** Refreshes requested sessions into the local corpus and reports available paths and unavailable sessions without publishing traces. */
export async function pullReviewTraceCorpus(input: {
  repo: { owner: string; repo: string };
  sessions: ReviewTracePullSession[];
  mainOnly?: boolean;
  cwd?: string;
  storage?: TraceStorage | null;
}): Promise<ReviewTracePullResult> {
  const repository = `${input.repo.owner}/${input.repo.repo}`;
  const corpusRoot = traceSearchCorpusDir();
  const storage = await storageFor(input.storage, input.cwd);
  const scope = (storage ? storage.cacheScope(input.repo) : null) ?? input.repo;

  const sessions: ReviewTracePullSessionResult[] = [];
  const unavailableSessions: string[] = [];
  const paths: string[] = [];

  for (const sessionRef of input.sessions) {
    const main = await loadReviewAgentTrace({
      sessionId: sessionRef.id,
      repo: input.repo,
      refresh: true,
      storage,
    });

    if (!main) {
      unavailableSessions.push(sessionRef.id);
      continue;
    }

    paths.push(normalizedTracePath(scope, sessionRef.id, "main"));
    let traceCount = 1;
    let eventCount = main.trace.events.length;

    if (!input.mainOnly) {
      for (const traceName of sessionRef.traces ?? main.subagents) {
        const subagent = await loadReviewAgentTrace({
          sessionId: sessionRef.id,
          trace: traceName,
          repo: input.repo,
          refresh: true,
          storage,
        });

        if (subagent) {
          paths.push(normalizedTracePath(scope, sessionRef.id, traceName));
          traceCount += 1;
          eventCount += subagent.trace.events.length;
        }
      }
    }

    sessions.push({
      session: sessionRef.id,
      traces: traceCount,
      events: eventCount,
      files: traceCount,
    });
  }

  return {
    corpusRoot,
    repository,
    sessions,
    unavailableSessions,
    events: sessions.reduce((total, session) => total + session.events, 0),
    files: sessions.reduce((total, session) => total + session.files, 0),
    paths,
  };
}

/** Resolves sessions by commit trailers, then the store index, then a pull-request scan, retaining the lookup source. */
export async function lookupReviewTraceCommit(input: {
  cwd: string;
  sha: string;
  storage?: TraceStorage | null;
}): Promise<ReviewTraceCommitLookupResult> {
  const storage = await storageFor(input.storage, input.cwd);
  const commit = await resolveCommitSha(input.cwd, input.sha);
  const trailerSessions = await readTrailerSessions(input.cwd, commit);
  const pr = await readSubjectPullNumber(input.cwd, commit);

  // Step 1: local trailers
  if (trailerSessions.length > 0) {
    const sessionMeta = await enrichSessionMeta(trailerSessions, storage);

    const result: ReviewTraceCommitLookupResult = {
      commit,
      sessions: trailerSessions,
      pr,
      branch: null,
      source: "trailer",
    };

    if (sessionMeta) result.session_meta = sessionMeta;

    return result;
  }

  // Step 2: the store's commit index
  const indexed = storage ? await storage.sessionsForCommit(commit) : null;

  if (indexed && indexed.sessions.length > 0) {
    const sessions = deduplicateStrings(indexed.sessions);
    const sessionMeta = await enrichSessionMeta(sessions, storage);

    const result: ReviewTraceCommitLookupResult = {
      commit,
      sessions,
      pr: indexed.pr ?? pr,
      branch: indexed.branch ?? null,
      source: "index",
    };

    if (sessionMeta) result.session_meta = sessionMeta;

    return result;
  }

  // Step 3: PR scan if commit subject ends in PR number
  if (pr !== null) {
    const prSessions = await prScanTrailerSessions(input.cwd, commit, pr);

    if (prSessions.length > 0) {
      const sessionMeta = await enrichSessionMeta(prSessions, storage);

      const result: ReviewTraceCommitLookupResult = {
        commit,
        sessions: prSessions,
        pr,
        branch: null,
        source: "pr-scan",
      };

      if (sessionMeta) result.session_meta = sessionMeta;

      return result;
    }
  }

  return {
    commit,
    sessions: [],
    pr,
    branch: null,
    source: "none",
  };
}

async function enrichSessionMeta(
  sessions: string[],
  storage: TraceStorage | null,
): Promise<
  | Record<
      string,
      {
        repo?: string | null;
        branch?: string | null;
        pr?: number | null;
        author?: string | null;
      }
    >
  | undefined
> {
  if (!storage || sessions.length === 0) return undefined;

  const detail: Record<
    string,
    {
      repo?: string | null;
      branch?: string | null;
      pr?: number | null;
      author?: string | null;
    }
  > = {};

  for (const session of sessions) {
    const meta = await storage.sessionMeta(session);

    if (meta) {
      detail[session] = {
        repo: meta.repo,
        branch: meta.branch,
        pr: meta.pr,
        author: meta.author,
      };
    }
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** Validates a session ID and combines store metadata with remote and local transcript availability without publishing traces. */
export async function lookupReviewTraceSession(input: {
  sessionId: string;
  storage?: TraceStorage | null;
}): Promise<ReviewTraceSessionLookupResult> {
  const parseResult = sessionIdSchema.safeParse(input.sessionId);

  if (!parseResult.success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }

  const sessionId = parseResult.data;
  const storage = await storageFor(input.storage);

  const meta: SessionMeta | null = storage
    ? await storage.sessionMeta(sessionId)
    : null;

  let hasRawTrace = false;

  if (
    storage &&
    (await reachable(() => storage.describeObject(sessionId, "main"))) !== null
  ) {
    hasRawTrace = true;
  }

  if (!hasRawTrace) {
    const local = await findLocalTrace(sessionId);

    if (local && existsSync(local.tracePath)) {
      hasRawTrace = true;
    }
  }

  const subagentSet = new Set<string>();

  if (storage) {
    for (const s of await listSessionSubagents(sessionId, storage)) {
      subagentSet.add(s);
    }
  }

  const local = await findLocalTrace(sessionId);

  if (local) {
    for (const s of local.subagentPaths) {
      subagentSet.add(s.name.replace(/\.jsonl(\.gz)?$/, ""));
    }
  }

  return {
    session: sessionId,
    meta,
    has_raw_trace: hasRawTrace,
    subagents: [...subagentSet],
  };
}

/** Resolves sessions for file blame or history commits, preserving their resolution order and lookup sources. */
export async function lookupReviewTraceBlame(input: {
  cwd: string;
  file: string;
  lines?: string;
  history?: boolean;
  storage?: TraceStorage | null;
}): Promise<ReviewTraceBlameLookupResult> {
  if (!input.file) {
    throw new Error("File path is required.");
  }

  if (input.lines) {
    const match = /^(\d+)(?:,(\d+))?$/.exec(input.lines.trim());

    if (!match) {
      throw new Error(
        `Invalid line range "${input.lines}". Expected start,end or single line number.`,
      );
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;

    if (start <= 0 || end < start) {
      throw new Error(
        `Invalid line range "${input.lines}". Start must be >= 1 and end >= start.`,
      );
    }
  }

  let shas: string[] = [];

  if (input.history) {
    const spec = input.lines
      ? `${input.lines}:${input.file}`
      : `1,$:${input.file}`;

    const res = await gitAt(
      input.cwd,
      ["log", "-L", spec, "--format=%H", "-s"],
      { allowFailure: true },
    );

    if (!res.ok) {
      throw new Error(
        res.stderr.trim() || `git log -L failed for ${input.file}`,
      );
    }

    shas = deduplicateStrings(res.stdout.trim().split(/\s+/).filter(Boolean));
  } else {
    const args = ["blame", "--line-porcelain"];

    if (input.lines) {
      args.push("-L", input.lines);
    }

    args.push("--", input.file);
    const res = await gitAt(input.cwd, args, { allowFailure: true });

    if (!res.ok) {
      throw new Error(
        res.stderr.trim() || `git blame failed for ${input.file}`,
      );
    }

    const collected: string[] = [];

    for (const line of res.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);

      if (parts.length >= 3 && /^[0-9a-f]{40,64}$/i.test(parts[0])) {
        if (!collected.includes(parts[0])) {
          collected.push(parts[0]);
        }
      }
    }

    shas = collected;
  }

  const storage = await storageFor(input.storage, input.cwd);
  const resolutions: ReviewTraceCommitLookupResult[] = [];

  for (const sha of shas) {
    resolutions.push(
      await lookupReviewTraceCommit({ cwd: input.cwd, sha, storage }),
    );
  }

  return {
    file: input.file,
    range: input.lines ?? null,
    history: Boolean(input.history),
    resolutions,
  };
}

/** Clears saved trace environment values and remote freshness timestamps without deleting normalized copies. */
export function clearTraceEnvCache(): void {
  clearS3EnvCache();
  lastCheckedTimes.clear();
}

/** Subagent traces known locally or in the store, by name without ".jsonl". */
async function listSessionSubagents(
  sessionId: string,
  storage?: TraceStorage | null,
): Promise<string[]> {
  const subagents = new Set<string>();

  for (const localSessionDir of findNormalizedSessionDirs(sessionId)) {
    try {
      for (const entry of readdirSync(localSessionDir)) {
        if (entry.endsWith(".jsonl") && entry !== "main.jsonl") {
          subagents.add(entry.slice(0, -6));
        }
      }
    } catch {
      // Ignore local read errors
    }
  }

  const store = await storageFor(storage);

  if (store) {
    const names = await reachable(() => store.listSubagents(sessionId));

    for (const name of names ?? []) subagents.add(name);
  }

  return [...subagents].sort();
}

// A squash merge rewrites the commit message from the pull request title
// and body, so the Agent-Session trailers written by the repository hooks
// never reach the commit that lands on the target branch. When the range
// carries no trailers and no index entries, scan each commit's pull
// request branch for the trailers instead.
async function addSessionsFromPrScan(
  rootPath: string,
  commits: CommitWithSessions[],
  sessions: Map<string, ReviewTraceSessionRef>,
): Promise<void> {
  const scannedPrs = new Set<number>();

  for (const commit of commits) {
    const pr = subjectPullNumber(commit.subject);

    if (pr === null || scannedPrs.has(pr)) continue;
    scannedPrs.add(pr);
    const prSessions = await prScanTrailerSessions(rootPath, commit.sha, pr);

    for (const sessionId of prSessions) {
      const existing = sessions.get(sessionId);

      if (existing) {
        existing.commits.push({ sha: commit.sha, subject: commit.subject });
      } else {
        sessions.set(sessionId, {
          sessionId,
          commits: [{ sha: commit.sha, subject: commit.subject }],
        });
      }
    }
  }
}

async function addSessionsFromStoreIndex(
  storage: TraceStorage | null,
  commits: CommitWithSessions[],
  sessions: Map<string, ReviewTraceSessionRef>,
): Promise<void> {
  if (!storage) return;

  for (const commit of commits) {
    const indexed = await storage.sessionsForCommit(commit.sha);

    if (!indexed) continue;

    for (const sessionId of indexed.sessions) {
      const existing = sessions.get(sessionId);

      if (existing) {
        existing.commits.push({ sha: commit.sha, subject: commit.subject });
      } else {
        sessions.set(sessionId, {
          sessionId,
          commits: [{ sha: commit.sha, subject: commit.subject }],
        });
      }
    }
  }
}
