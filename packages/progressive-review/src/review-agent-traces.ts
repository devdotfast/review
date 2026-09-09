import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { git } from "@dev.fast/local-vcs";
import {
  type ReviewAgentTraceSession,
  type SessionMeta,
  commitShaSchema,
  isStringValue,
  parseJsonText,
  sessionIdSchema,
} from "@dev.fast/review-protocol";

import {
  AGENT_TRACE_PARSER_VERSION,
  type AgentTraceEvent,
  type AgentTraceHarness,
  type AgentTraceParseResult,
  extractTraceEventText,
  parseAgentTraceJsonl,
} from "./agent-trace-parser";
import {
  exportOpenCodeTrace,
  isOpenCodeSessionId,
} from "./opencode-trace-export";
import { devReviewHome } from "./review-storage";
import {
  type TraceRepo,
  inferRepoFromGit,
  parseRepo,
  traceRepoName,
} from "./trace-repo";
import {
  isTraceStorageConfigured,
  resolveTraceStorage,
} from "./trace-storage/resolve";
import { S3TraceStorage } from "./trace-storage/s3";
import {
  clearTraceEnvCache as clearS3EnvCache,
  resolveS3Setup,
  traceEnvValue as s3EnvValue,
} from "./trace-storage/s3-config";
import {
  type HostedPublishDetails,
  type TraceStorage,
  TraceStorageUnavailableError,
} from "./trace-storage/types";
import { TUTORIAL_TRACE_SESSION_ID, loadTutorialTrace } from "./tutorial-trace";

export { type TraceRepo, inferRepoFromGit, parseRepo, traceRepoName };

/**
 * Resolves the agent sessions behind a review's change range, loads their
 * transcripts, publishes local agent traces to the selected trace store, and
 * materializes a local corpus for FFF search. Bucket and hosted specifics
 * live behind the TraceStorage boundary in ./trace-storage.
 */

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const STORE_COMMIT_LOOKUP_LIMIT = 30;
const REMOTE_HEAD_TTL_MS = 15_000;

export interface ReviewTraceCommitRef {
  sha: string;
  subject: string;
}

export interface ReviewTraceSessionRef {
  sessionId: string;
  commits: ReviewTraceCommitRef[];
}

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

export interface ReviewTraceDoctorResult {
  ok: boolean;
  envPath: string;
  config?: { endpoint: string; bucket: string; accessKeyId: string };
  reachable: boolean;
  error?: string;
}

const lastCheckedTimes = new Map<string, number>();

export function isTraceR2Configured(): boolean {
  return isTraceStorageConfigured();
}

/**
 * The store to read from or publish to: an explicit override, or the
 * machine's selected store. Null means no remote storage is configured.
 */
async function storageFor(
  storage: TraceStorage | null | undefined,
  cwd?: string,
): Promise<TraceStorage | null> {
  return storage === undefined ? resolveTraceStorage({ cwd }) : storage;
}

/** A remote lookup, or null when the store could not be reached. */
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
    return !trace || trace === "main" ? loadTutorialTrace() : null;
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
    let remote: Awaited<ReturnType<TraceStorage["describeObject"]>>;
    try {
      remote = await storage.describeObject(sessionId, traceName);
    } catch (error) {
      // The store did not answer: the saved copy, if any, is all there is.
      if (!(error instanceof TraceStorageUnavailableError)) throw error;
      return normalized
        ? loadedNormalizedTrace(normalized, input.commits, "offline")
        : null;
    }
    lastCheckedTimes.set(checkKey, now);
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
 * Whether a saved copy still matches the stored object. Direct storage can
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

interface NormalizedTraceMetadata {
  type: "metadata";
  version: 1;
  parserVersion: string;
  repository: string;
  session: string;
  trace: string;
  harness: AgentTraceHarness;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  activeMs: number | null;
  userTurns: number;
  toolCalls: number;
  subagents: string[];
  source: {
    r2Key: string;
    bytes: number;
    checkedAt: string;
    /** What the backend verified about the content; absent in old caches. */
    contentId?: string;
    /** The store the copy came from; absent in caches older than this field. */
    storage?: string;
  };
}

interface NormalizedTraceEventRecord {
  type: "event";
  index: number;
  kind: AgentTraceEvent["kind"];
  text: string;
  event: AgentTraceEvent;
}

interface NormalizedTrace {
  metadata: NormalizedTraceMetadata;
  events: NormalizedTraceEventRecord[];
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

function writeNormalizedTraceAtomic(
  targetPath: string,
  trace: NormalizedTrace,
): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const content = [trace.metadata, ...trace.events]
    .map((record) => JSON.stringify(record))
    .join("\n");
  try {
    writeFileSync(tempPath, `${content}\n`, "utf8");
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * A saved copy, or null when the file is absent, written by another parser
 * version, or made for another store. A copy that names its store is served
 * only to that store; a copy from before the field is trusted only by direct
 * storage, which wrote every such file.
 */
function readNormalizedTrace(
  filePath: string,
  storage?: TraceStorage | null,
): NormalizedTrace | null {
  try {
    const records: unknown[] = readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJsonText(line));
    // SAFETY: normalized traces are written only by writeNormalizedTraceAtomic
    // from a NormalizedTrace; the type, version, parserVersion, and source
    // checks below reject any file that is not one of ours.
    const metadata = records[0] as NormalizedTraceMetadata | undefined;
    if (
      !metadata ||
      metadata.type !== "metadata" ||
      metadata.version !== 1 ||
      metadata.parserVersion !== AGENT_TRACE_PARSER_VERSION ||
      !Number.isFinite(metadata.source?.bytes)
    ) {
      return null;
    }
    if (storage) {
      const owner = metadata.source.storage;
      if (owner !== undefined && owner !== storage.cacheIdentity()) return null;
      if (owner === undefined && storage.kind !== "s3") return null;
    }
    // SAFETY: same file provenance as the metadata record above; each event
    // record's type, index, kind, and text are re-checked against its event.
    const events = records.slice(1) as NormalizedTraceEventRecord[];
    if (
      events.some(
        (record, index) =>
          record.type !== "event" ||
          record.index !== index ||
          record.kind !== record.event?.kind ||
          record.text !== extractTraceEventText(record.event),
      )
    ) {
      return null;
    }
    return { metadata, events };
  } catch {
    return null;
  }
}

export interface ReviewTracePullSession {
  id: string;
  traces?: string[];
}

export interface ReviewTracePullSessionResult {
  session: string;
  traces: number;
  events: number;
  files: number;
}

export interface ReviewTracePullResult {
  corpusRoot: string;
  repository: string;
  sessions: ReviewTracePullSessionResult[];
  unavailableSessions: string[];
  events: number;
  files: number;
  paths: string[];
}

export function traceSearchCorpusDir(): string {
  const dir =
    process.env.REVIEW_TEST_TRACE_SEARCH_DIR ??
    path.join(devReviewHome(), "trace-search");
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

type RepoInput = string | { owner: string; repo: string };

function normalizeRepo(repo: RepoInput): { owner: string; repo: string } {
  return isRepoSlug(repo) ? parseRepo(repo) : repo;
}

/** Whether a repo input is the "owner/repo" slug form. */
function isRepoSlug(repo: RepoInput): repo is string {
  return isStringValue(repo);
}

function normalizedTracePath(
  repo: { owner: string; repo: string },
  sessionId: string,
  traceName: string,
): string {
  return path.join(
    traceSearchCorpusDir(),
    corpusPathSegment(repo.owner, "owner"),
    corpusPathSegment(repo.repo, "repository"),
    corpusPathSegment(sessionId, "session"),
    `${corpusPathSegment(traceName.replace(/\.jsonl$/, ""), "trace")}.jsonl`,
  );
}

function findNormalizedTraceFile(
  sessionId: string,
  traceName: string,
  storage?: TraceStorage | null,
): string | null {
  const fileName = `${corpusPathSegment(traceName.replace(/\.jsonl$/, ""), "trace")}.jsonl`;
  // A store that places its own cache never reads another store's files.
  const own = storage?.cacheScope(null);
  if (own) {
    const candidate = path.join(
      path.dirname(normalizedTracePath(own, sessionId, "main")),
      fileName,
    );
    return isFile(candidate) ? candidate : null;
  }
  for (const sessionDir of findNormalizedSessionDirs(sessionId)) {
    const candidate = path.join(sessionDir, fileName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function findNormalizedSessionDirs(sessionId: string): string[] {
  const root = traceSearchCorpusDir();
  const session = corpusPathSegment(sessionId, "session");
  const results: string[] = [];
  try {
    for (const owner of readdirSync(root, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const ownerDir = path.join(root, owner.name);
      for (const repo of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        const candidate = path.join(ownerDir, repo.name, session);
        if (isDirectory(candidate)) results.push(candidate);
      }
    }
  } catch {
    return [];
  }
  return results.sort();
}

function corpusPathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label} path segment: ${value}`);
  }
  return value;
}

// The version-1 cache record names the bucket object it came from. Keep
// writing that label so existing caches and readers agree on the format.
function legacyObjectKey(sessionId: string, traceName: string): string {
  if (traceName === "main") return `by-session/${sessionId}/trace.jsonl`;
  const base = path.basename(traceName);
  const fileName = base.endsWith(".jsonl") ? base : `${base}.jsonl`;
  return `by-session/${sessionId}/subagents/${fileName}`;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    // SAFETY: execFile rejects with an Error whose stdout and stderr fields
    // hold the child's output as strings; both are read as optional so any
    // other rejection still reports String(error).
    const err = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
    };
  }
}

// --- Lookup Commit & Session -----------------------------------------------

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

function deduplicateStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
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
    const res = await runGit(input.cwd, [
      "log",
      "-L",
      spec,
      "--format=%H",
      "-s",
    ]);
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
    const res = await runGit(input.cwd, args);
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

// --- Local Trace Discovery & Sync ------------------------------------------

export interface LocalTraceDiscovery {
  tracePath: string;
  harness: LocalTraceHarness;
  subagentPaths: Array<{ name: string; path: string }>;
}

export type LocalTraceHarness = "claude" | "codex" | "opencode" | "pi";

export async function findLocalTrace(
  sessionId: string,
): Promise<LocalTraceDiscovery | null> {
  if (!sessionIdSchema.safeParse(sessionId).success) return null;

  const claudeRoot =
    traceEnvValue("TRACE_LOCAL_TRACE_ROOT") ||
    path.join(homedir(), ".claude", "projects");
  const codexRoot = codexSessionsRoot();
  const piRoot =
    traceEnvValue("TRACE_PI_SESSIONS_ROOT") ||
    path.join(homedir(), ".pi", "agent", "sessions");

  let harness: LocalTraceHarness = "claude";
  let tracePath = findClaudeTrace(claudeRoot, sessionId);
  if (!tracePath) {
    tracePath = findCodexTrace(codexRoot, sessionId);
    if (tracePath) harness = "codex";
  }
  if (!tracePath) {
    tracePath = findPiTrace(piRoot, sessionId);
    if (tracePath) harness = "pi";
  }

  if (!tracePath) {
    if (
      existsSync(claudeRoot) &&
      isFile(path.join(claudeRoot, `${sessionId}.jsonl`))
    ) {
      tracePath = path.join(claudeRoot, `${sessionId}.jsonl`);
      harness = "claude";
    }
  }

  // OpenCode has no transcript file to find; the session is rendered fresh
  // from its database each time so a sync sees everything up to now.
  if (!tracePath && isOpenCodeSessionId(sessionId)) {
    tracePath = await exportOpenCodeTrace({
      sessionId,
      root:
        process.env.TRACE_OPENCODE_TRACES_ROOT ||
        path.join(devReviewHome(), "opencode-traces"),
    });
    if (tracePath) harness = "opencode";
  }

  if (!tracePath) return null;

  const subagentPaths = findSubagentBlobs(tracePath);
  return { tracePath, harness, subagentPaths };
}

function findClaudeTrace(root: string, sessionId: string): string | null {
  const fileName = `${sessionId}.jsonl`;
  if (!existsSync(root)) return null;
  const direct = path.join(root, fileName);
  if (isFile(direct)) return direct;
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(root, entry.name, fileName);
        if (isFile(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function findCodexTrace(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  const suffix = `-${sessionId}.jsonl`;
  return (
    listFilesRecursive(root)
      .sort()
      .find((entry) => {
        const name = path.basename(entry);
        return name.startsWith("rollout-") && name.endsWith(suffix);
      }) ?? null
  );
}

export function indexCodexTraceFiles(files: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of [...files].sort()) {
    const name = path.basename(entry);
    const match =
      /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(
        name,
      );
    if (match && !index.has(match[1])) index.set(match[1], entry);
  }
  return index;
}

function findPiTrace(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(root, entry.name);
        for (const file of readdirSync(subDir)) {
          if (
            file.endsWith(`_${sessionId}.jsonl`) ||
            file === `${sessionId}.jsonl`
          ) {
            const candidate = path.join(subDir, file);
            if (isFile(candidate)) return candidate;
          }
        }
      } else if (entry.isFile()) {
        if (
          entry.name.endsWith(`_${sessionId}.jsonl`) ||
          entry.name === `${sessionId}.jsonl`
        ) {
          return path.join(root, entry.name);
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function findSubagentBlobs(
  tracePath: string,
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];
  const stem = tracePath.endsWith(".jsonl")
    ? tracePath.slice(0, -".jsonl".length)
    : tracePath;

  const subagentsDir = path.join(stem, "subagents");
  if (existsSync(subagentsDir)) {
    try {
      for (const name of readdirSync(subagentsDir)) {
        if (name.endsWith(".jsonl")) {
          results.push({ name, path: path.join(subagentsDir, name) });
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  if (existsSync(stem)) {
    try {
      for (const childEntry of readdirSync(stem, { withFileTypes: true })) {
        if (childEntry.isDirectory() && childEntry.name !== "subagents") {
          const childDir = path.join(stem, childEntry.name);
          for (const runEntry of readdirSync(childDir, {
            withFileTypes: true,
          })) {
            if (runEntry.isDirectory() && runEntry.name.startsWith("run-")) {
              const runFile = path.join(
                childDir,
                runEntry.name,
                "session.jsonl",
              );
              if (isFile(runFile)) {
                const shortChild = childEntry.name.slice(0, 8);
                results.push({
                  name: `pi-${runEntry.name}-${shortChild}.jsonl`,
                  path: runFile,
                });
              }
            }
          }
        }
      }
    } catch {
      // Ignore Pi child directory read errors
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

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
  // transcript; direct publication has no such gate.
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

export async function checkReviewTraceDoctor(input?: {
  cwd?: string;
}): Promise<ReviewTraceDoctorResult> {
  void input;
  const setup = resolveS3Setup();
  // The path reported is the source the credentials came from: the
  // version-2 profile when it supplies them, otherwise the legacy env file.
  const envPath = setup.source === "profile" ? setup.configPath : setup.envPath;

  if (process.env.TRACE_R2_MODE === "mock") {
    return {
      ok: true,
      envPath,
      config: {
        endpoint: "mock://endpoint",
        bucket: "mock-bucket",
        accessKeyId: "mock-key",
      },
      reachable: true,
    };
  }

  const config = setup.credentials;
  if (!config) {
    const anyInput =
      setup.profile !== null ||
      existsSync(setup.envPath) ||
      Boolean(process.env.TRACE_R2_BUCKET);
    return {
      ok: false,
      envPath,
      reachable: false,
      error: anyInput
        ? "Configuration is missing one or more required S3/R2 values."
        : "No trace configuration found. Use Review Agent Setup to configure trace capture.",
    };
  }

  const summary = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
  };
  const doctor = await S3TraceStorage.fromCredentials(config).doctor();
  if (doctor.reachable) {
    return { ok: true, envPath, config: summary, reachable: true };
  }
  return {
    ok: false,
    envPath,
    config: summary,
    reachable: false,
    error: doctor.error,
  };
}

// --- Commit trailer resolution ---------------------------------------------

interface CommitWithSessions extends ReviewTraceCommitRef {
  sessions: string[];
}

export async function resolveCommitSha(
  cwd: string,
  rev: string,
): Promise<string> {
  const result = await git(
    cwd,
    ["rev-parse", "--verify", "--end-of-options", rev],
    { allowFailure: true },
  );
  return result.ok && result.stdout.trim() ? result.stdout.trim() : rev;
}

export async function readTrailerSessions(
  cwd: string,
  rev: string,
): Promise<string[]> {
  const result = await git(
    cwd,
    [
      "show",
      "-s",
      "--format=%(trailers:key=Agent-Session,valueonly)",
      "--end-of-options",
      rev,
    ],
    { allowFailure: true },
  );
  if (!result.ok) return [];
  const sessions: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const value = line.trim();
    if (
      value &&
      sessionIdSchema.safeParse(value).success &&
      !sessions.includes(value)
    ) {
      sessions.push(value);
    }
  }
  return sessions;
}

export async function listRepositoryTraceSessionIds(
  cwd: string,
): Promise<string[]> {
  const result = await runGit(cwd, [
    "log",
    "--all",
    "--no-show-signature",
    "--format=%(trailers:key=Agent-Session,valueonly,separator=%x1f)",
  ]);
  if (!result.ok) return [];

  return deduplicateStrings(
    result.stdout
      .split(/[\n\x1f]+/)
      .map((value) => value.trim())
      .filter((value) => sessionIdSchema.safeParse(value).success),
  );
}

export async function readSubjectPullNumber(
  cwd: string,
  rev: string,
): Promise<number | null> {
  const result = await git(
    cwd,
    ["show", "-s", "--format=%s", "--end-of-options", rev],
    { allowFailure: true },
  );
  if (!result.ok) return null;
  return subjectPullNumber(result.stdout.trim());
}

export function subjectPullNumber(subject: string): number | null {
  const match = /\(#(\d+)\)$/.exec(subject);
  return match ? Number(match[1]) : null;
}

export async function readRepoMetaFields(
  cwd: string,
): Promise<{ author: string | null; branch: string | null }> {
  const insideResult = await git(cwd, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  if (!insideResult.ok || insideResult.stdout.trim() !== "true") {
    return { author: null, branch: null };
  }
  const branchResult = await git(cwd, ["branch", "--show-current"], {
    allowFailure: true,
  });
  const branch = branchResult.ok ? branchResult.stdout.trim() : null;
  const authorResult = await git(cwd, ["config", "user.email"], {
    allowFailure: true,
  });
  const author = authorResult.ok ? authorResult.stdout.trim() : null;
  return { author: author || null, branch: branch || null };
}

async function commitsWithTrailers(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}): Promise<CommitWithSessions[]> {
  if (input.baseCommit === input.headCommit) return [];
  const format = [
    "%H",
    "%s",
    "%(trailers:key=Agent-Session,valueonly,separator=%x1f)",
  ].join("%x1f");
  const result = await git(
    input.rootPath,
    [
      "log",
      "--no-show-signature",
      `--format=${format}${RECORD_SEPARATOR}`,
      `${input.baseCommit}..${input.headCommit}`,
    ],
    { allowFailure: true },
  );
  if (!result.ok) return [];
  const commits: CommitWithSessions[] = [];
  for (const chunk of result.stdout.split(RECORD_SEPARATOR)) {
    const record = chunk.replace(/^\s+/, "");
    if (!record) continue;
    const [sha, subject, ...trailerFields] = record.split(FIELD_SEPARATOR);
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const sessions = [
      ...new Set(trailerFields.flatMap((field) => field.split("\n"))),
    ]
      .map((value) => value.trim())
      .filter((value) => sessionIdSchema.safeParse(value).success);
    commits.push({ sha, subject: subject ?? "", sessions });
  }
  return commits;
}

// --- R2 trace store and local materialization -------------------------------

export function clearTraceEnvCache(): void {
  clearS3EnvCache();
  lastCheckedTimes.clear();
}

export function traceEnvValue(name: string): string | undefined {
  return s3EnvValue(name);
}

// Codex reads CODEX_HOME from its own environment only, so this does not
// consult the trace env file for it.
export function codexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME;
  return (
    traceEnvValue("TRACE_CODEX_SESSIONS_ROOT") ||
    path.join(
      codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex"),
      "sessions",
    )
  );
}

const execFileAsync = promisify(execFile);

/** Subagent traces known locally or in the store, by name without ".jsonl". */
export async function listSessionSubagents(
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

export async function prScanTrailerSessions(
  cwd: string,
  commit: string,
  pr: number,
): Promise<string[]> {
  const fetchRes = await runGit(cwd, [
    "fetch",
    "--quiet",
    "origin",
    `refs/pull/${pr}/head`,
  ]);
  if (!fetchRes.ok) return [];
  let revListRes = await runGit(cwd, [
    "rev-list",
    "FETCH_HEAD",
    "--not",
    `${commit}^`,
  ]);
  if (!revListRes.ok) {
    revListRes = await runGit(cwd, [
      "rev-list",
      "FETCH_HEAD",
      "--not",
      `${commit}~1`,
    ]);
  }
  if (!revListRes.ok) {
    revListRes = await runGit(cwd, ["rev-list", "FETCH_HEAD"]);
  }
  if (!revListRes.ok) return [];
  const branchShas = revListRes.stdout.trim().split(/\s+/).filter(Boolean);
  const prSessions: string[] = [];
  for (const branchSha of branchShas) {
    const sessionsOnSha = await readTrailerSessions(cwd, branchSha);
    for (const s of sessionsOnSha) {
      if (!prSessions.includes(s)) {
        prSessions.push(s);
      }
    }
  }
  return prSessions;
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

function isFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function listFilesRecursive(dirPath: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(full));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  } catch {
    // Ignore read errors
  }
  return files;
}
