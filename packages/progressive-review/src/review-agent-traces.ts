import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  type ByCommitEntry,
  type SessionMeta,
  byCommitSchema,
  commitShaSchema,
  sessionIdSchema,
  sessionMetaSchema,
} from "@dev-fast/trace-shared";
import { git, resolveRepoContext } from "@dev.fast/local-vcs";
import type { ReviewAgentTraceSession } from "@dev.fast/review-protocol";

import {
  AGENT_TRACE_PARSER_VERSION,
  type AgentTraceEvent,
  type AgentTraceHarness,
  type AgentTraceParseResult,
  extractTraceEventText,
  parseAgentTraceJsonl,
  sniffAgentTraceHarness,
} from "./agent-trace-parser";

/**
 * Resolves the agent sessions behind a review's change range, loads their
 * transcripts, syncs local agent traces directly to R2, and materializes a
 * local corpus for FFF search.
 */

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const R2_COMMIT_LOOKUP_LIMIT = 30;
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

export interface ReviewTraceSyncUpload {
  blob: string;
  bytes_stored: number;
  status: "uploaded" | "unchanged";
}

export interface ReviewTraceSyncResult {
  session: string;
  repo: string;
  uploads: ReviewTraceSyncUpload[];
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
  if (process.env.TRACE_R2_MODE === "mock") return true;
  const config = traceR2Config();
  return config !== null;
}

export async function listReviewTraceSessions(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}): Promise<ReviewTraceSessionDescriptor[]> {
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
  if (sessions.size === 0 && commits.length <= R2_COMMIT_LOOKUP_LIMIT) {
    await addSessionsFromR2Index(commits, sessions);
  }
  if (sessions.size === 0 && commits.length <= R2_COMMIT_LOOKUP_LIMIT) {
    await addSessionsFromPrScan(input.rootPath, commits, sessions);
  }

  const descriptors: ReviewTraceSessionDescriptor[] = [];
  for (const ref of sessions.values()) {
    const desc = await describeTraceSession(ref);
    descriptors.push(desc);
  }
  return descriptors;
}

export function sniffTraceHarnessFromFile(filePath: string): AgentTraceHarness {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = readSync(fd, buffer, 0, 4096, 0);
      const chunk = buffer.toString("utf8", 0, bytesRead);
      return sniffAgentTraceHarness(chunk);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "unknown";
  }
}

export async function describeTraceSession(
  ref: ReviewTraceSessionRef,
): Promise<ReviewTraceSessionDescriptor> {
  const configured = isTraceR2Configured();
  const mainKey = `by-session/${ref.sessionId}/trace.jsonl`;
  const local = findNormalizedTraceFile(ref.sessionId, "main");
  const normalized = local ? readNormalizedTrace(local) : null;
  const remoteSize = configured ? await r2HeadObjectSize(mainKey) : null;
  const available =
    normalized !== null || (remoteSize !== null && remoteSize > 0);
  const harness = normalized?.metadata.harness ?? "unknown";

  const subagents = await listSessionSubagents(ref.sessionId);

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
}): Promise<LoadedReviewAgentTrace | null> {
  const { sessionId, trace } = input;
  if (!sessionIdSchema.safeParse(sessionId).success) return null;
  const traceName = trace ?? "main";
  const traceKey =
    traceName === "main"
      ? `by-session/${sessionId}/trace.jsonl`
      : `by-session/${sessionId}/subagents/${normalizeSubagentFileName(traceName)}`;

  let normalizedPath = input.repo
    ? normalizedTracePath(normalizeRepo(input.repo), sessionId, traceName)
    : findNormalizedTraceFile(sessionId, traceName);
  let normalized = normalizedPath ? readNormalizedTrace(normalizedPath) : null;
  const now = Date.now();
  const lastChecked = lastCheckedTimes.get(traceKey) ?? 0;
  const canUseWithoutCheck =
    normalized && !input.refresh && now - lastChecked < REMOTE_HEAD_TTL_MS;

  if (!canUseWithoutCheck) {
    const remoteSize = await r2HeadObjectSize(traceKey);
    lastCheckedTimes.set(traceKey, now);
    const mustMaterialize =
      remoteSize !== null &&
      (!normalized || remoteSize > normalized.metadata.source.bytes);
    if (mustMaterialize) {
      let repo = input.repo ? normalizeRepo(input.repo) : null;
      if (!repo && input.cwd) {
        repo = await inferRepoFromGit(input.cwd).catch(() => null);
      }
      if (!repo) {
        const meta = await r2GetJson<SessionMeta>(
          `by-session/${sessionId}/meta.json`,
        );
        if (meta?.repo) {
          try {
            repo = parseRepo(meta.repo);
          } catch {
            repo = null;
          }
        }
      }
      if (!repo) {
        return normalized
          ? loadedNormalizedTrace(normalized, input.commits)
          : null;
      }
      normalizedPath = normalizedTracePath(repo, sessionId, traceName);
      normalized = await materializeNormalizedTrace({
        sessionId,
        traceName,
        traceKey,
        normalizedPath,
        repo,
      });
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
  source: { r2Key: string; bytes: number; checkedAt: string };
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
  traceKey: string;
  normalizedPath: string;
  repo: { owner: string; repo: string };
}): Promise<NormalizedTrace | null> {
  const rawTempPath = path.join(
    tmpdir(),
    `review-trace-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  try {
    if (!(await r2GetObject(input.traceKey, rawTempPath))) return null;
    const parsed = parseAgentTraceJsonl(readFileSync(rawTempPath, "utf8"), {
      isSubagent: input.traceName !== "main",
    });
    const subagents = await listSessionSubagents(input.sessionId);
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
          r2Key: input.traceKey,
          bytes: statSync(rawTempPath).size,
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
    const records = readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const metadata = records[0] as NormalizedTraceMetadata | undefined;
    if (
      !metadata ||
      metadata.type !== "metadata" ||
      metadata.version !== 1 ||
      metadata.parserVersion !== AGENT_TRACE_PARSER_VERSION ||
      typeof metadata.source?.bytes !== "number"
    ) {
      return null;
    }
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
}): Promise<ReviewTracePullResult> {
  const repository = `${input.repo.owner}/${input.repo.repo}`;
  const corpusRoot = traceSearchCorpusDir();

  const sessions: ReviewTracePullSessionResult[] = [];
  const unavailableSessions: string[] = [];
  const paths: string[] = [];
  for (const sessionRef of input.sessions) {
    const main = await loadReviewAgentTrace({
      sessionId: sessionRef.id,
      repo: input.repo,
      refresh: true,
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

function normalizeRepo(repo: string | { owner: string; repo: string }): {
  owner: string;
  repo: string;
} {
  return typeof repo === "string" ? parseRepo(repo) : repo;
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
    const err = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
    };
  }
}

export const r2ListSubagents = listSessionSubagents;

// --- Lookup Commit & Session -----------------------------------------------

export async function lookupReviewTraceCommit(input: {
  cwd: string;
  sha: string;
}): Promise<ReviewTraceCommitLookupResult> {
  const commit = await resolveCommitSha(input.cwd, input.sha);
  const trailerSessions = await readTrailerSessions(input.cwd, commit);
  const pr = await readSubjectPullNumber(input.cwd, commit);

  // Step 1: local trailers
  if (trailerSessions.length > 0) {
    const sessionMeta = await enrichSessionMeta(trailerSessions);
    return {
      commit,
      sessions: trailerSessions,
      pr,
      branch: null,
      source: "trailer",
      ...(sessionMeta ? { session_meta: sessionMeta } : {}),
    };
  }

  // Step 2: direct R2 by-commit index
  let r2Entry: ByCommitEntry | null = null;
  if (isTraceR2Configured() && commitShaSchema.safeParse(commit).success) {
    try {
      const raw = await r2GetJson<unknown>(`by-commit/${commit}.json`);
      const parsed = byCommitSchema.safeParse(raw);
      if (parsed.success && parsed.data.sessions.length > 0) {
        r2Entry = parsed.data;
      }
    } catch {
      // R2 read error; proceed to next steps
    }
  }

  if (r2Entry && r2Entry.sessions.length > 0) {
    const sessions = deduplicateStrings(r2Entry.sessions);
    const sessionMeta = await enrichSessionMeta(sessions);
    return {
      commit,
      sessions,
      pr: r2Entry.pr ?? pr,
      branch: r2Entry.branch ?? null,
      source: "index",
      ...(sessionMeta ? { session_meta: sessionMeta } : {}),
    };
  }

  // Step 3: PR scan if commit subject ends in PR number
  if (pr !== null) {
    const prSessions = await prScanTrailerSessions(input.cwd, commit, pr);
    if (prSessions.length > 0) {
      const sessionMeta = await enrichSessionMeta(prSessions);
      return {
        commit,
        sessions: prSessions,
        pr,
        branch: null,
        source: "pr-scan",
        ...(sessionMeta ? { session_meta: sessionMeta } : {}),
      };
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

async function enrichSessionMeta(sessions: string[]): Promise<
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
  if (!isTraceR2Configured() || sessions.length === 0) return undefined;
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
    try {
      const raw = await r2GetJson<unknown>(`by-session/${session}/meta.json`);
      const parsed = sessionMetaSchema.safeParse(raw);
      if (parsed.success) {
        detail[session] = {
          repo: parsed.data.repo,
          branch: parsed.data.branch,
          pr: parsed.data.pr,
          author: parsed.data.author,
        };
      }
    } catch {
      // Ignore individual session metadata fetch errors
    }
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export async function lookupReviewTraceSession(input: {
  sessionId: string;
}): Promise<ReviewTraceSessionLookupResult> {
  const parseResult = sessionIdSchema.safeParse(input.sessionId);
  if (!parseResult.success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }
  const sessionId = parseResult.data;

  let meta: SessionMeta | null = null;
  if (isTraceR2Configured()) {
    try {
      const raw = await r2GetJson<unknown>(`by-session/${sessionId}/meta.json`);
      if (raw) {
        const parsed = sessionMetaSchema.safeParse(raw);
        if (parsed.success) {
          meta = parsed.data;
        }
      }
    } catch {
      // Ignore error fetching metadata
    }
  }

  let hasRawTrace = false;
  if (isTraceR2Configured()) {
    const size = await r2HeadObjectSize(`by-session/${sessionId}/trace.jsonl`);
    if (size !== null) {
      hasRawTrace = true;
    }
  }
  if (!hasRawTrace) {
    const local = await findLocalTrace(sessionId);
    if (local && existsSync(local.tracePath)) {
      hasRawTrace = true;
    }
  }

  const subagentSet = new Set<string>();
  if (isTraceR2Configured()) {
    const r2Subs = await r2ListSubagents(sessionId);
    for (const s of r2Subs) {
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
  subagentPaths: Array<{ name: string; path: string }>;
}

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

  let tracePath =
    findClaudeTrace(claudeRoot, sessionId) ||
    findCodexTrace(codexRoot, sessionId) ||
    findPiTrace(piRoot, sessionId);

  if (!tracePath) {
    if (
      existsSync(claudeRoot) &&
      isFile(path.join(claudeRoot, `${sessionId}.jsonl`))
    ) {
      tracePath = path.join(claudeRoot, `${sessionId}.jsonl`);
    }
  }

  if (!tracePath) return null;

  const subagentPaths = findSubagentBlobs(tracePath);
  return { tracePath, subagentPaths };
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
  return findCodexTraceInFiles(listFilesRecursive(root), sessionId);
}

export function findCodexTraceInFiles(
  files: string[],
  sessionId: string,
): string | null {
  const suffix = `-${sessionId}.jsonl`;
  return (
    [...files].sort().find((entry) => {
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
}): Promise<ReviewTraceSyncResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionIdSchema.safeParse(sessionId).success) {
    throw new Error(
      "Session id must be 8-128 characters of letters, digits, dots, dashes, or underscores.",
    );
  }
  if (!isTraceR2Configured()) {
    throw new Error(
      "S3/R2 storage is not configured. Use Review Agent Setup to configure trace capture.",
    );
  }

  const local = await findLocalTrace(sessionId);
  if (!local) {
    throw new Error(`No local trace found for session ${sessionId}.`);
  }

  const workDir = input.cwd ?? process.cwd();
  const repo = input.repo
    ? parseRepo(input.repo)
    : await inferRepoFromGit(workDir);

  const uploads: ReviewTraceSyncUpload[] = [];

  // Main trace upload
  const mainKey = `by-session/${sessionId}/trace.jsonl`;
  const mainGrown = await r2PutIfGrown(mainKey, local.tracePath);
  const mainBytes = statSync(local.tracePath).size;
  uploads.push({
    blob: "trace.jsonl",
    bytes_stored: mainBytes,
    status: mainGrown ? "uploaded" : "unchanged",
  });

  // Subagent uploads
  for (const sub of local.subagentPaths) {
    const subKey = `by-session/${sessionId}/subagents/${sub.name}`;
    const subGrown = await r2PutIfGrown(subKey, sub.path);
    const subBytes = statSync(sub.path).size;
    uploads.push({
      blob: `subagents/${sub.name}`,
      bytes_stored: subBytes,
      status: subGrown ? "uploaded" : "unchanged",
    });
  }

  // Update session metadata (read-merge-write)
  const { author, branch } = await readRepoMetaFields(workDir);
  const metaKey = `by-session/${sessionId}/meta.json`;
  const existingMeta = await r2GetJson<SessionMeta>(metaKey);

  const mergedCommits = deduplicateStrings([
    ...(existingMeta?.commits ?? []),
    ...(input.commits ?? []).filter(
      (commit) => commitShaSchema.safeParse(commit).success,
    ),
  ]);
  const mergedRepo = `${repo.owner}/${repo.repo}`;
  const mergedBranch = branch ?? existingMeta?.branch ?? null;
  const mergedAuthor = author ?? existingMeta?.author ?? null;
  const mergedPr = existingMeta?.pr ?? null;

  const newMeta: SessionMeta = {
    session: sessionId,
    repo: mergedRepo,
    branch: mergedBranch,
    pr: mergedPr,
    commits: mergedCommits,
    author: mergedAuthor,
    ts: new Date().toISOString(),
  };

  const metaSaved = await r2PutBuffer(
    metaKey,
    Buffer.from(JSON.stringify(newMeta, null, 2), "utf8"),
  );
  if (!metaSaved) {
    throw new Error(
      `Failed to update session metadata for ${sessionId} in S3/R2 storage.`,
    );
  }

  return {
    session: sessionId,
    repo: mergedRepo,
    uploads,
  };
}

export async function writeReviewTraceCommitMapping(input: {
  cwd: string;
  commit: string;
  sessions: string[];
  branch: string | null;
}): Promise<boolean> {
  const commit = commitShaSchema.parse(input.commit);
  const existing = await r2GetJson<unknown>(`by-commit/${commit}.json`);
  if (existing !== null) return false;
  const repo = await inferRepoFromGit(input.cwd);
  const entry: ByCommitEntry = byCommitSchema.parse({
    commit,
    sessions: deduplicateStrings(input.sessions),
    repo: `${repo.owner}/${repo.repo}`,
    pr: await readSubjectPullNumber(input.cwd, commit),
    branch: input.branch,
    indexed_by: "hook",
    ts: new Date().toISOString(),
  });
  const saved = await r2PutBuffer(
    `by-commit/${commit}.json`,
    Buffer.from(JSON.stringify(entry, null, 2), "utf8"),
  );
  if (!saved) {
    throw new Error(`Failed to write by-commit/${commit}.json.`);
  }
  return true;
}

export async function checkReviewTraceDoctor(input?: {
  cwd?: string;
}): Promise<ReviewTraceDoctorResult> {
  const envPath =
    process.env.TRACE_ENV_FILE ??
    path.join(homedir(), ".config", "dev-trace", "env");

  if (
    !existsSync(envPath) &&
    !process.env.TRACE_R2_BUCKET &&
    process.env.TRACE_R2_MODE !== "mock"
  ) {
    return {
      ok: false,
      envPath,
      reachable: false,
      error:
        "No trace configuration found. Use Review Agent Setup to configure trace capture.",
    };
  }

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

  const config = traceR2Config();
  if (!config) {
    return {
      ok: false,
      envPath,
      reachable: false,
      error: "Configuration is missing one or more required S3/R2 values.",
    };
  }

  try {
    await execFileAsync(
      "aws",
      [
        "--region",
        config.region,
        "--endpoint-url",
        config.endpoint,
        "s3api",
        "head-bucket",
        "--bucket",
        config.bucket,
      ],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
    return {
      ok: true,
      envPath,
      config: {
        endpoint: config.endpoint,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
      },
      reachable: true,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      envPath,
      config: {
        endpoint: config.endpoint,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
      },
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

export function parseRepo(value: string): { owner: string; repo: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository must be OWNER/REPO.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function inferRepoFromGit(
  cwd: string,
): Promise<{ owner: string; repo: string }> {
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

// --- R2 trace store and local materialization -------------------------------

export interface TraceR2Config {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  // SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's
  // real region.
  region: string;
}

let cachedTraceEnv: Record<string, string> | null = null;

export function clearTraceEnvCache(): void {
  cachedTraceEnv = null;
  lastCheckedTimes.clear();
}

function traceEnvFile(): Record<string, string> {
  if (cachedTraceEnv) return cachedTraceEnv;
  const values: Record<string, string> = {};
  const envPath =
    process.env.TRACE_ENV_FILE ??
    path.join(homedir(), ".config", "dev-trace", "env");
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    // No env file; exported variables may still be present.
  }
  cachedTraceEnv = values;
  return values;
}

export function traceEnvValue(name: string): string | undefined {
  return process.env[name] ?? traceEnvFile()[name];
}

export function codexSessionsRoot(): string {
  const codexHome = traceEnvValue("CODEX_HOME");
  return (
    traceEnvValue("TRACE_CODEX_SESSIONS_ROOT") ||
    path.join(
      codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex"),
      "sessions",
    )
  );
}

export function traceR2Config(): TraceR2Config | null {
  const bucket = traceEnvValue("TRACE_R2_BUCKET");
  const endpoint = traceEnvValue("TRACE_R2_ENDPOINT");
  const accessKeyId =
    traceEnvValue("TRACE_R2_ACCESS_KEY_ID") ??
    traceEnvValue("AWS_ACCESS_KEY_ID");
  const secretAccessKey =
    traceEnvValue("TRACE_R2_SECRET_ACCESS_KEY") ??
    traceEnvValue("AWS_SECRET_ACCESS_KEY");
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  const region = traceEnvValue("TRACE_R2_REGION") ?? "auto";
  return { bucket, endpoint, accessKeyId, secretAccessKey, region };
}

const execFileAsync = promisify(execFile);

export async function r2HeadObjectSize(key: string): Promise<number | null> {
  if (process.env.TRACE_R2_MODE === "mock") {
    const mockRoot = process.env.TRACE_R2_MOCK_DIR;
    if (!mockRoot) return null;
    const target = path.join(mockRoot, key);
    try {
      const stats = statSync(target);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  }

  const config = traceR2Config();
  if (!config) return null;
  try {
    const proc = await execFileAsync(
      "aws",
      [
        "--region",
        config.region,
        "--endpoint-url",
        config.endpoint,
        "s3api",
        "head-object",
        "--bucket",
        config.bucket,
        "--key",
        key,
      ],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
    const parsed = JSON.parse(proc.stdout) as { ContentLength?: number };
    return typeof parsed.ContentLength === "number"
      ? parsed.ContentLength
      : null;
  } catch {
    return null;
  }
}

export async function r2GetObject(
  key: string,
  destPath: string,
): Promise<boolean> {
  mkdirSync(path.dirname(destPath), { recursive: true });

  if (process.env.TRACE_R2_MODE === "mock") {
    const mockRoot = process.env.TRACE_R2_MOCK_DIR;
    if (!mockRoot) return false;
    const target = path.join(mockRoot, key);
    try {
      const content = readFileSync(target);
      writeFileSync(destPath, content);
      return true;
    } catch {
      return false;
    }
  }

  const config = traceR2Config();
  if (!config) return false;
  try {
    await execFileAsync(
      "aws",
      [
        "--region",
        config.region,
        "--endpoint-url",
        config.endpoint,
        "s3api",
        "get-object",
        "--bucket",
        config.bucket,
        "--key",
        key,
        destPath,
      ],
      {
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
    return existsSync(destPath);
  } catch {
    return false;
  }
}

export async function r2GetBuffer(key: string): Promise<Buffer | null> {
  const tmpPath = path.join(
    tmpdir(),
    `r2-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    const ok = await r2GetObject(key, tmpPath);
    if (!ok) return null;
    return readFileSync(tmpPath);
  } catch {
    return null;
  } finally {
    try {
      if (existsSync(tmpPath)) {
        const { rmSync } = await import("node:fs");
        rmSync(tmpPath, { force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export async function r2GetJson<T>(key: string): Promise<T | null> {
  const content = await r2GetBuffer(key);
  if (!content) return null;
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function r2PutFile(
  key: string,
  filePath: string,
): Promise<boolean> {
  if (process.env.TRACE_R2_MODE === "mock") {
    const mockRoot = process.env.TRACE_R2_MOCK_DIR;
    if (!mockRoot) return false;
    try {
      const target = path.join(mockRoot, key);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(filePath));
      return true;
    } catch {
      return false;
    }
  }

  const config = traceR2Config();
  if (!config) return false;
  try {
    await execFileAsync(
      "aws",
      [
        "--region",
        config.region,
        "--endpoint-url",
        config.endpoint,
        "s3",
        "cp",
        "--only-show-errors",
        filePath,
        `s3://${config.bucket}/${key}`,
      ],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

export async function r2PutBuffer(
  key: string,
  content: Buffer,
): Promise<boolean> {
  if (process.env.TRACE_R2_MODE === "mock") {
    const mockRoot = process.env.TRACE_R2_MOCK_DIR;
    if (!mockRoot) return false;
    try {
      const target = path.join(mockRoot, key);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      return true;
    } catch {
      return false;
    }
  }

  const tempFile = path.join(
    tmpdir(),
    `put-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tempFile, content);
  try {
    return await r2PutFile(key, tempFile);
  } finally {
    try {
      if (existsSync(tempFile)) {
        const { rmSync } = await import("node:fs");
        rmSync(tempFile, { force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export async function r2PutIfGrown(
  key: string,
  filePath: string,
): Promise<boolean> {
  const remoteSize = await r2HeadObjectSize(key);
  const localSize = statSync(filePath).size;
  if (remoteSize !== null && localSize <= remoteSize) {
    return false;
  }
  const uploaded = await r2PutFile(key, filePath);
  if (!uploaded) {
    throw new Error(`Failed to upload ${key} to S3/R2 storage.`);
  }
  return true;
}

export async function listSessionSubagents(
  sessionId: string,
): Promise<string[]> {
  const subagents = new Set<string>();
  const prefix = `by-session/${sessionId}/subagents/`;

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

  if (process.env.TRACE_R2_MODE === "mock") {
    const mockRoot = process.env.TRACE_R2_MOCK_DIR;
    if (mockRoot) {
      const dir = path.join(mockRoot, prefix);
      if (existsSync(dir)) {
        try {
          for (const entry of readdirSync(dir)) {
            if (entry.endsWith(".jsonl")) {
              subagents.add(entry.slice(0, -6));
            }
          }
        } catch {
          // Ignore mock readdir errors
        }
      }
    }
  } else {
    const config = traceR2Config();
    if (config) {
      try {
        const proc = await execFileAsync(
          "aws",
          [
            "--region",
            config.region,
            "--endpoint-url",
            config.endpoint,
            "s3api",
            "list-objects-v2",
            "--bucket",
            config.bucket,
            "--prefix",
            prefix,
          ],
          {
            timeout: 10_000,
            env: {
              ...process.env,
              AWS_ACCESS_KEY_ID: config.accessKeyId,
              AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
            },
          },
        );
        const parsed = JSON.parse(proc.stdout) as {
          Contents?: Array<{ Key?: string }>;
        };
        for (const item of parsed.Contents ?? []) {
          if (
            item.Key &&
            item.Key.startsWith(prefix) &&
            item.Key.endsWith(".jsonl")
          ) {
            const subName = item.Key.slice(prefix.length, -6);
            if (subName) subagents.add(subName);
          }
        }
      } catch {
        // Ignore remote list failure
      }
    }
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

async function addSessionsFromR2Index(
  commits: CommitWithSessions[],
  sessions: Map<string, ReviewTraceSessionRef>,
): Promise<void> {
  if (!isTraceR2Configured()) return;
  for (const commit of commits) {
    const key = `by-commit/${commit.sha}.json`;
    try {
      const entry = await r2GetJson<{
        sessions?: unknown;
      }>(key);
      if (!entry) continue;
      if (!Array.isArray(entry.sessions)) continue;
      for (const value of entry.sessions) {
        if (
          typeof value !== "string" ||
          !sessionIdSchema.safeParse(value).success
        ) {
          continue;
        }
        const existing = sessions.get(value);
        if (existing) {
          existing.commits.push({ sha: commit.sha, subject: commit.subject });
        } else {
          sessions.set(value, {
            sessionId: value,
            commits: [{ sha: commit.sha, subject: commit.subject }],
          });
        }
      }
    } catch {
      // Ignore malformed index entries.
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

function listFilesRecursive(dirPath: string): string[] {
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
