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

import {
  type TraceHarness,
  type TraceObjectName,
  traceObjectKey,
  traceObjectNameSchema,
} from "@dev-fast/trace-shared";
import { git, resolveRepoContext } from "@dev.fast/local-vcs";
import {
  type ReviewAgentTraceSession,
  type SessionMeta,
  commitShaSchema,
  isStringValue,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
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
import { requireStoreClient } from "./store-auth";
import { StoreApiError } from "./store-client";
import { resolveAllowedTraceRepository } from "./trace-hook-runner";
import {
  type TraceStoreSession,
  type TraceStoreTransport,
  createHttpTraceStoreTransport,
  gzipToTemp,
} from "./trace-store-transport";

/**
 * Resolves the agent sessions behind a review's change range, loads their
 * transcripts, ships local agent traces to the hosted trace store, and
 * materializes a local corpus for FFF search.
 */

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const STORE_COMMIT_LOOKUP_LIMIT = 30;
const REMOTE_HEAD_TTL_MS = 15_000;
/** The store accepts at most 200 commits and 64 objects for one session. */
const SESSION_COMMIT_LIMIT = 200;
const SESSION_OBJECT_LIMIT = 64;

export interface ReviewTraceCommitRef {
  sha: string;
  subject: string;
}

export interface ReviewTraceSessionRef {
  sessionId: string;
  commits: ReviewTraceCommitRef[];
}

export type ReviewTraceSessionDescriptor = ReviewAgentTraceSession;

export interface LoadedReviewAgentTrace {
  parserVersion: string;
  descriptor: ReviewTraceSessionDescriptor;
  trace: AgentTraceParseResult;
  subagents: string[];
  traceName: string | null;
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

export interface ReviewTraceSyncResult {
  session: string;
  repo: string;
  repositoryId: number;
  stored: "written";
  objects: string[];
  commits: string[];
}

/** Reports why a store read gave nothing back. */
export type TraceStoreWarning = (message: string) => void;

/** One repository's store, reached with the saved login. */
export interface TraceStoreAccess {
  transport: TraceStoreTransport;
  repositoryId: number;
  warn?: TraceStoreWarning;
}

export interface TraceStoreAccessInput {
  cwd?: string;
  transport?: TraceStoreTransport;
  repositoryId?: number;
  /** Where a store failure is reported. Commands pass their own stderr. */
  onWarning?: TraceStoreWarning;
}

function defaultTraceStoreWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * One line that names why a store read failed, or null when the answer means
 * the store simply holds nothing for this repository or session.
 */
function storeReadWarning(error: unknown): string | null {
  if (error instanceof StoreApiError) {
    if (error.code === "not_found") return null;
    if (error.code === "unauthorized") {
      return "Trace store request failed: unauthorized. Run `review login`.";
    }
    if (error.code === "forbidden") {
      return `Trace store request failed: forbidden. ${error.message}`;
    }
    return `Trace store request failed: ${error.message}`;
  }
  return `Trace store request failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

/** Reports one store failure on the caller's channel, or on stderr. */
function reportStoreFailure(access: TraceStoreAccess, error: unknown): void {
  const message = storeReadWarning(error);
  if (message) (access.warn ?? defaultTraceStoreWarning)(message);
}

const lastCheckedTimes = new Map<string, number>();

/**
 * The store for this repository, or null when the repository is not allowed
 * or the user is not logged in. Read paths then work from the local corpus
 * alone.
 */
export async function resolveTraceStoreAccess(
  input: TraceStoreAccessInput = {},
): Promise<TraceStoreAccess | null> {
  let repositoryId = input.repositoryId;
  if (repositoryId === undefined) {
    const entry = await resolveAllowedTraceRepository(
      input.cwd ?? process.cwd(),
    );
    if (!entry) return null;
    repositoryId = entry.repositoryId;
  }
  const warn = input.onWarning;
  if (input.transport) {
    return {
      transport: input.transport,
      repositoryId,
      ...(warn ? { warn } : {}),
    };
  }
  try {
    return {
      transport: createHttpTraceStoreTransport(await requireStoreClient()),
      repositoryId,
      ...(warn ? { warn } : {}),
    };
  } catch {
    // The repository is allowed but the machine holds no login.
    (warn ?? defaultTraceStoreWarning)(
      "The trace store login is missing. Run `review login`.",
    );
    return null;
  }
}

/** The store's record of one session, or null when the store has none. */
async function readStoreSession(
  access: TraceStoreAccess,
  sessionId: string,
): Promise<TraceStoreSession | null> {
  try {
    const response = await access.transport.listSessions(access.repositoryId, {
      session: sessionId,
    });
    return response.sessions[0] ?? null;
  } catch (error) {
    reportStoreFailure(access, error);
    return null;
  }
}

/** The object name the store uses for one trace of a session. */
function traceObjectName(traceName: string): TraceObjectName {
  return traceName === "main"
    ? "main.jsonl.gz"
    : `subagents/${normalizeSubagentFileName(traceName)}.gz`;
}

/** The parser's name for one store harness. */
function parserHarness(
  harness: TraceHarness | undefined,
): AgentTraceHarness | null {
  if (harness === undefined) return null;
  return harness === "claude" ? "claude-code" : harness;
}

/** The trace name behind one store object name. */
function traceNameFromObject(name: string): string {
  if (name === "main.jsonl.gz") return "main";
  return name.slice("subagents/".length, -".jsonl.gz".length);
}

export async function listReviewTraceSessions(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
  transport?: TraceStoreTransport;
  repositoryId?: number;
  onWarning?: TraceStoreWarning;
}): Promise<ReviewTraceSessionDescriptor[]> {
  const access = await resolveTraceStoreAccess({
    cwd: input.rootPath,
    transport: input.transport,
    repositoryId: input.repositoryId,
    onWarning: input.onWarning,
  });
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
  if (
    access &&
    sessions.size === 0 &&
    commits.length <= STORE_COMMIT_LOOKUP_LIMIT
  ) {
    await addSessionsFromStoreIndex(access, commits, sessions);
  }
  if (sessions.size === 0 && commits.length <= STORE_COMMIT_LOOKUP_LIMIT) {
    await addSessionsFromPrScan(input.rootPath, commits, sessions);
  }

  const descriptors: ReviewTraceSessionDescriptor[] = [];
  for (const ref of sessions.values()) {
    const desc = await describeTraceSession(ref, access);
    descriptors.push(desc);
  }
  return descriptors;
}

export async function describeTraceSession(
  ref: ReviewTraceSessionRef,
  access?: TraceStoreAccess | null,
): Promise<ReviewTraceSessionDescriptor> {
  const local = findNormalizedTraceFile(ref.sessionId, "main");
  const normalized = local ? readNormalizedTrace(local) : null;
  const stored = access ? await readStoreSession(access, ref.sessionId) : null;
  const available = normalized !== null || stored !== null;
  const harness =
    normalized?.metadata.harness ?? parserHarness(stored?.harness) ?? "unknown";

  const subagents = await listSessionSubagents(
    ref.sessionId,
    storedSubagentNames(stored),
  );

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
  access?: TraceStoreAccess | null;
  transport?: TraceStoreTransport;
  repositoryId?: number;
  onWarning?: TraceStoreWarning;
}): Promise<LoadedReviewAgentTrace | null> {
  const { sessionId, trace } = input;
  if (!sessionIdSchema.safeParse(sessionId).success) return null;
  const traceName = trace ?? "main";
  const objectName = traceObjectName(traceName);

  let normalizedPath = input.repo
    ? normalizedTracePath(normalizeRepo(input.repo), sessionId, traceName)
    : findNormalizedTraceFile(sessionId, traceName);
  let normalized = normalizedPath ? readNormalizedTrace(normalizedPath) : null;
  const now = Date.now();
  const checkKey = `${sessionId}/${objectName}`;
  const lastChecked = lastCheckedTimes.get(checkKey) ?? 0;
  const canUseWithoutCheck =
    normalized && !input.refresh && now - lastChecked < REMOTE_HEAD_TTL_MS;

  if (!canUseWithoutCheck) {
    const access =
      input.access === undefined
        ? await resolveTraceStoreAccess({
            cwd: input.cwd,
            transport: input.transport,
            repositoryId: input.repositoryId,
            onWarning: input.onWarning,
          })
        : input.access;
    const stored = access ? await readStoreSession(access, sessionId) : null;
    const object = stored?.objects.find((entry) => entry.name === objectName);
    lastCheckedTimes.set(checkKey, now);
    const mustMaterialize =
      access !== null &&
      object !== undefined &&
      (!normalized || object.size > normalized.metadata.source.bytes);
    if (access && stored && object && mustMaterialize) {
      let repo = input.repo ? normalizeRepo(input.repo) : null;
      if (!repo && input.cwd) {
        repo = await inferRepoFromGit(input.cwd).catch(() => null);
      }
      if (!repo) {
        return normalized
          ? loadedNormalizedTrace(normalized, input.commits)
          : null;
      }
      normalizedPath = normalizedTracePath(repo, sessionId, traceName);
      normalized =
        (await materializeNormalizedTrace({
          sessionId,
          traceName,
          key: traceObjectKey(access.repositoryId, sessionId, objectName),
          url: object.url,
          bytes: object.size,
          subagents: storedSubagentNames(stored),
          normalizedPath,
          repo,
          transport: access.transport,
        })) ?? normalized;
    }
  }

  if (!normalized) return null;
  return loadedNormalizedTrace(normalized, input.commits);
}

function loadedNormalizedTrace(
  normalized: NormalizedTrace,
  commits: ReviewTraceCommitRef[] | undefined,
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
  source: { key: string; bytes: number; checkedAt: string };
}

/** Corpus files written before the hosted store named the key `r2Key`. */
interface LegacyNormalizedTraceSource {
  r2Key?: string;
  key?: string;
  bytes?: number;
  checkedAt?: string;
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
  sessionId: string;
  traceName: string;
  key: string;
  url: string;
  bytes: number;
  subagents: string[];
  normalizedPath: string;
  repo: { owner: string; repo: string };
  transport: TraceStoreTransport;
}): Promise<NormalizedTrace | null> {
  const rawTempPath = path.join(
    tmpdir(),
    `review-trace-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  try {
    try {
      await input.transport.getObject(input.url, rawTempPath);
    } catch {
      return null;
    }
    const parsed = parseAgentTraceJsonl(readFileSync(rawTempPath, "utf8"), {
      isSubagent: input.traceName !== "main",
    });
    const subagents = await listSessionSubagents(
      input.sessionId,
      input.subagents,
    );
    const normalized: NormalizedTrace = {
      metadata: {
        type: "metadata",
        version: 1,
        parserVersion: AGENT_TRACE_PARSER_VERSION,
        repository: `${input.repo.owner}/${input.repo.repo}`,
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
          key: input.key,
          bytes: input.bytes,
          checkedAt: new Date().toISOString(),
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

function readNormalizedTrace(filePath: string): NormalizedTrace | null {
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
    metadata.source = migrateNormalizedTraceSource(metadata.source);
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
    path.join(homedir(), ".dev", "trace-search");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function pullReviewTraceCorpus(input: {
  repo: { owner: string; repo: string };
  sessions: ReviewTracePullSession[];
  mainOnly?: boolean;
  cwd?: string;
  transport?: TraceStoreTransport;
  repositoryId?: number;
  onWarning?: TraceStoreWarning;
}): Promise<ReviewTracePullResult> {
  const repository = `${input.repo.owner}/${input.repo.repo}`;
  const corpusRoot = traceSearchCorpusDir();
  const access = await resolveTraceStoreAccess({
    cwd: input.cwd,
    transport: input.transport,
    repositoryId: input.repositoryId,
    onWarning: input.onWarning,
  });

  const sessions: ReviewTracePullSessionResult[] = [];
  const unavailableSessions: string[] = [];
  const paths: string[] = [];
  for (const sessionRef of input.sessions) {
    const main = await loadReviewAgentTrace({
      sessionId: sessionRef.id,
      repo: input.repo,
      refresh: true,
      access,
    });
    if (!main) {
      unavailableSessions.push(sessionRef.id);
      continue;
    }
    paths.push(normalizedTracePath(input.repo, sessionRef.id, "main"));
    let traceCount = 1;
    let eventCount = main.trace.events.length;
    if (!input.mainOnly) {
      for (const traceName of sessionRef.traces ?? main.subagents) {
        const subagent = await loadReviewAgentTrace({
          sessionId: sessionRef.id,
          trace: traceName,
          repo: input.repo,
          refresh: true,
          access,
        });
        if (subagent) {
          paths.push(normalizedTracePath(input.repo, sessionRef.id, traceName));
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
): string | null {
  const fileName = `${corpusPathSegment(traceName.replace(/\.jsonl$/, ""), "trace")}.jsonl`;
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

function normalizeSubagentFileName(name: string): string {
  const base = path.basename(name);
  return base.endsWith(".jsonl") ? base : `${base}.jsonl`;
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
  transport?: TraceStoreTransport;
  repositoryId?: number;
  onWarning?: TraceStoreWarning;
}): Promise<ReviewTraceCommitLookupResult> {
  const commit = await resolveCommitSha(input.cwd, input.sha);
  const trailerSessions = await readTrailerSessions(input.cwd, commit);
  const pr = await readSubjectPullNumber(input.cwd, commit);

  // Step 1: local trailers
  if (trailerSessions.length > 0) {
    return {
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
  if (commitShaSchema.safeParse(commit).success) {
    const access = await resolveTraceStoreAccess({
      cwd: input.cwd,
      transport: input.transport,
      repositoryId: input.repositoryId,
      onWarning: input.onWarning,
    });
    const sessions = access
      ? await listStoreSessionsForCommit(access, commit)
      : [];
    if (sessions.length > 0) {
      return {
        commit,
        sessions: sessions.map((session) => session.sessionId),
        pr,
        branch: null,
        source: "index",
      };
    }
  }

  // Step 3: PR scan if commit subject ends in PR number
  if (pr !== null) {
    const prSessions = await prScanTrailerSessions(input.cwd, commit, pr);
    if (prSessions.length > 0) {
      return {
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

/** The sessions the store recorded for one commit. */
async function listStoreSessionsForCommit(
  access: TraceStoreAccess,
  commit: string,
): Promise<TraceStoreSession[]> {
  try {
    const response = await access.transport.listSessions(access.repositoryId, {
      commit,
    });
    return response.sessions;
  } catch (error) {
    reportStoreFailure(access, error);
    return [];
  }
}

export async function lookupReviewTraceSession(input: {
  sessionId: string;
  cwd?: string;
  transport?: TraceStoreTransport;
  repositoryId?: number;
  onWarning?: TraceStoreWarning;
}): Promise<ReviewTraceSessionLookupResult> {
  const parseResult = sessionIdSchema.safeParse(input.sessionId);
  if (!parseResult.success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }
  const sessionId = parseResult.data;

  const access = await resolveTraceStoreAccess({
    cwd: input.cwd,
    transport: input.transport,
    repositoryId: input.repositoryId,
    onWarning: input.onWarning,
  });
  const stored = access ? await readStoreSession(access, sessionId) : null;
  const repositoryName = access
    ? await inferRepoFromGit(input.cwd ?? process.cwd())
        .then((repo) => `${repo.owner}/${repo.repo}`)
        .catch(() => null)
    : null;
  const meta: SessionMeta | null = stored
    ? {
        session: sessionId,
        repo: repositoryName,
        branch: null,
        pr: null,
        commits: stored.commits,
        author: null,
        ts: stored.updatedAt,
      }
    : null;

  const local = await findLocalTrace(sessionId);
  const hasRawTrace =
    stored !== null || (local !== null && existsSync(local.tracePath));

  const subagentSet = new Set<string>(storedSubagentNames(stored));
  for (const subagent of local?.subagentPaths ?? []) {
    subagentSet.add(subagent.name.replace(/\.jsonl(\.gz)?$/, ""));
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

  const resolutions: ReviewTraceCommitLookupResult[] = [];
  for (const sha of shas) {
    resolutions.push(await lookupReviewTraceCommit({ cwd: input.cwd, sha }));
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
  harness: TraceHarness;
  subagentPaths: Array<{ name: string; path: string }>;
}

export async function findLocalTrace(
  sessionId: string,
): Promise<LocalTraceDiscovery | null> {
  if (!sessionIdSchema.safeParse(sessionId).success) return null;

  const claudeRoot =
    process.env.TRACE_LOCAL_TRACE_ROOT ||
    path.join(homedir(), ".claude", "projects");
  const codexRoot = codexSessionsRoot();
  const piRoot =
    process.env.TRACE_PI_SESSIONS_ROOT ||
    path.join(homedir(), ".pi", "agent", "sessions");

  let harness: TraceHarness = "claude";
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
  transport?: TraceStoreTransport;
}): Promise<ReviewTraceSyncResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionIdSchema.safeParse(sessionId).success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }

  const workDir = input.cwd ?? process.cwd();
  const entry = await resolveAllowedTraceRepository(workDir);
  if (!entry) {
    throw new Error(
      "This repository is not allowed for trace publication. Run `review trace allow .`.",
    );
  }
  const transport =
    input.transport ??
    createHttpTraceStoreTransport(await requireStoreClient());

  const local = await findLocalTrace(sessionId);
  if (!local) {
    throw new Error(`No local trace found for session ${sessionId}.`);
  }

  const repo = input.repo
    ? parseRepo(input.repo)
    : await inferRepoFromGit(workDir).catch(() => parseRepo(entry.name));

  // The store names every object and takes at most 64 of them for one
  // session. A name it cannot accept, or a subagent past the limit, stays on
  // the machine instead of failing the whole session.
  const files: Array<{ name: TraceObjectName; path: string }> = [
    { name: "main.jsonl.gz", path: local.tracePath },
  ];
  for (const subagent of local.subagentPaths) {
    if (files.length >= SESSION_OBJECT_LIMIT) break;
    const name = traceObjectName(subagent.name.replace(/\.jsonl$/, ""));
    if (!traceObjectNameSchema.safeParse(name).success) continue;
    files.push({ name, path: subagent.path });
  }

  const compressed: Array<{
    name: TraceObjectName;
    size: number;
    sha256: string;
    path: string;
    cleanup: () => Promise<void>;
  }> = [];
  try {
    for (const file of files) {
      const gzipped = await gzipToTemp(file.path);
      compressed.push({ name: file.name, ...gzipped });
    }

    const begun = await transport.beginUpload(entry.repositoryId, sessionId, {
      harness: local.harness,
      objects: compressed.map((object) => ({
        name: object.name,
        size: object.size,
        sha256: object.sha256,
      })),
    });
    for (const upload of begun.uploads) {
      const object = compressed.find((entry) => entry.name === upload.name);
      if (!object) {
        throw new Error(
          `The trace store asked for an object this session does not have: ${upload.name}.`,
        );
      }
      await transport.putObject(upload, object.path);
    }

    const commits =
      input.commits?.filter(
        (commit) => commitShaSchema.safeParse(commit).success,
      ) ?? (await commitsForTraceSession(workDir, sessionId));
    const completed = await transport.completeUpload(
      entry.repositoryId,
      sessionId,
      { commits: commits.slice(0, SESSION_COMMIT_LIMIT) },
    );

    return {
      session: sessionId,
      repo: `${repo.owner}/${repo.repo}`,
      repositoryId: entry.repositoryId,
      stored: "written",
      objects: completed.objects.map((object) => object.name),
      commits: completed.commits,
    };
  } finally {
    for (const object of compressed) {
      await object.cleanup();
    }
  }
}

/** The commits whose Agent-Session trailers name this session. */
async function commitsForTraceSession(
  cwd: string,
  sessionId: string,
): Promise<string[]> {
  const result = await runGit(cwd, [
    "log",
    "--all",
    "--no-show-signature",
    `--format=%H${FIELD_SEPARATOR}%(trailers:key=Agent-Session,valueonly,separator=${FIELD_SEPARATOR})`,
  ]);
  if (!result.ok) return [];
  const commits: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const [sha, ...trailers] = line.trim().split(FIELD_SEPARATOR);
    if (!commitShaSchema.safeParse(sha).success) continue;
    const named = trailers
      .flatMap((value) => value.split("\n"))
      .some((value) => value.trim() === sessionId);
    if (named && !commits.includes(sha)) commits.push(sha);
  }
  return commits;
}

/**
 * Adds the commits a Git hook resolved to a session the store already holds.
 * A session that never shipped carries its commits on the next sync instead.
 */
export async function writeReviewTraceCommitMapping(input: {
  cwd: string;
  commit: string;
  sessions: string[];
  branch: string | null;
}): Promise<boolean> {
  const commit = commitShaSchema.parse(input.commit);
  const access = await resolveTraceStoreAccess({ cwd: input.cwd });
  if (!access) return false;
  let written = false;
  for (const sessionId of deduplicateStrings(input.sessions)) {
    try {
      await access.transport.completeUpload(access.repositoryId, sessionId, {
        commits: [commit],
      });
      written = true;
    } catch {
      // The store holds no complete upload for this session yet.
    }
  }
  return written;
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

export interface TraceRepo {
  owner: string;
  repo: string;
}

export function parseRepo(value: string): TraceRepo {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository must be OWNER/REPO.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function inferRepoFromGit(cwd: string): Promise<TraceRepo> {
  if (process.env.GITHUB_REPOSITORY) {
    return parseRepo(process.env.GITHUB_REPOSITORY);
  }
  const slug = (await resolveRepoContext(cwd))?.githubSlug;
  if (slug) {
    return parseRepo(slug);
  }
  const result = await git(cwd, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  if (result.ok && result.stdout.trim()) {
    const raw = result.stdout.trim();
    const match = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(raw);
    if (match && match[1] && match[2]) {
      return parseRepo(`${match[1]}/${match[2]}`);
    }
  }
  throw new Error("Could not infer GitHub repository from origin remote.");
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

// --- Local trace roots -----------------------------------------------------

const execFileAsync = promisify(execFile);

// Codex reads CODEX_HOME from its own environment.
export function codexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME;
  return (
    process.env.TRACE_CODEX_SESSIONS_ROOT ||
    path.join(
      codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex"),
      "sessions",
    )
  );
}

export async function listSessionSubagents(
  sessionId: string,
  storedNames: string[] = [],
): Promise<string[]> {
  const subagents = new Set<string>(storedNames);

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

  return [...subagents].sort();
}

/** The subagent trace names one store session holds. */
function storedSubagentNames(session: TraceStoreSession | null): string[] {
  return (session?.objects ?? [])
    .filter((object) => object.name !== "main.jsonl.gz")
    .map((object) => traceNameFromObject(object.name));
}

/** Old corpus files named the store key `r2Key`. */
function migrateNormalizedTraceSource(
  source: LegacyNormalizedTraceSource,
): NormalizedTraceMetadata["source"] {
  if (source.key !== undefined) {
    return {
      key: source.key,
      bytes: source.bytes ?? 0,
      checkedAt: source.checkedAt ?? "",
    };
  }
  // An old file counted the raw bytes, which no store object size matches.
  // Zero bytes makes the next check materialize the trace once.
  return {
    key: source.r2Key ?? "",
    bytes: 0,
    checkedAt: source.checkedAt ?? "",
  };
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
  access: TraceStoreAccess,
  commits: CommitWithSessions[],
  sessions: Map<string, ReviewTraceSessionRef>,
): Promise<void> {
  for (const commit of commits) {
    if (!commitShaSchema.safeParse(commit.sha).success) continue;
    for (const stored of await listStoreSessionsForCommit(access, commit.sha)) {
      const existing = sessions.get(stored.sessionId);
      if (existing) {
        existing.commits.push({ sha: commit.sha, subject: commit.subject });
      } else {
        sessions.set(stored.sessionId, {
          sessionId: stored.sessionId,
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
