import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { isStringValue, parseJsonText } from "@dev.fast/json";
import { git, gitAt } from "@dev.fast/local-vcs";
import { sessionIdSchema } from "@dev.fast/trace-protocol";

import {
  AGENT_TRACE_PARSER_VERSION,
  type AgentTraceEvent,
  type AgentTraceHarness,
  extractTraceEventText,
} from "./agent-trace-parser";
import { writeFileAtomic } from "./atomic-write";
import { devReviewHome } from "./trace-home";
import { parseRepo } from "./trace-repo";
import { type TraceStorage } from "./trace-storage/types";

const RECORD_SEPARATOR = "\u001e";

const FIELD_SEPARATOR = "\u001f";

export interface ReviewTraceCommitRef {
  sha: string;
  subject: string;
}

export interface ReviewTraceSessionRef {
  sessionId: string;
  commits: ReviewTraceCommitRef[];
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

export interface NormalizedTrace {
  metadata: NormalizedTraceMetadata;
  events: NormalizedTraceEventRecord[];
}

/** Atomically replaces a normalized JSONL copy without changing its version-1 record format. */
export function writeNormalizedTraceAtomic(
  targetPath: string,
  trace: NormalizedTrace,
): void {
  const content = [trace.metadata, ...trace.events]
    .map((record) => JSON.stringify(record))
    .join("\n");

  writeFileAtomic(targetPath, `${content}\n`, "utf8");
}

/**
 * A saved copy, or null when the file is absent, written by another parser
 * version, or made for another store. A copy that names its store is served
 * only to that store; a copy from before the field is trusted only by s3
 * storage, which wrote every such file.
 */
export function readNormalizedTrace(
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

/** Creates and returns the configured local search corpus directory; it performs no remote lookup. */
export function traceSearchCorpusDir(): string {
  const dir =
    process.env.REVIEW_TEST_TRACE_SEARCH_DIR ??
    path.join(devReviewHome(), "trace-search");

  mkdirSync(dir, { recursive: true });

  return dir;
}

type RepoInput = string | { owner: string; repo: string };

/** Parses a repository slug or returns the supplied owner/repo pair without consulting Git. */
export function normalizeRepo(repo: RepoInput): {
  owner: string;
  repo: string;
} {
  return isRepoSlug(repo) ? parseRepo(repo) : repo;
}

/** Whether a repo input is the "owner/repo" slug form. */
function isRepoSlug(repo: RepoInput): repo is string {
  return isStringValue(repo);
}

/** Builds a validated corpus path and ensures the corpus root exists; it does not write a trace. */
export function normalizedTracePath(
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

/** Finds a local copy compatible with the supplied store, restricting scoped stores to their own paths; it never downloads content. */
export function findNormalizedTraceFile(
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

  // The corpus holds every store's copies; the first file that is ours wins,
  // not the first file that exists.
  for (const sessionDir of findNormalizedSessionDirs(sessionId)) {
    const candidate = path.join(sessionDir, fileName);

    if (!isFile(candidate)) continue;

    if (!storage || readNormalizedTrace(candidate, storage) !== null) {
      return candidate;
    }
  }

  return null;
}

/** Returns sorted local corpus directories for a session, or an empty list on traversal failure. */
export function findNormalizedSessionDirs(sessionId: string): string[] {
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

/** Returns the version-1 bucket object label for cache metadata without accessing storage. */
export function legacyObjectKey(sessionId: string, traceName: string): string {
  if (traceName === "main") return `by-session/${sessionId}/trace.jsonl`;
  const base = path.basename(traceName);
  const fileName = base.endsWith(".jsonl") ? base : `${base}.jsonl`;

  return `by-session/${sessionId}/subagents/${fileName}`;
}

/** Returns distinct strings in first-seen order without modifying the input. */
export function deduplicateStrings(items: string[]): string[] {
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

export interface CommitWithSessions extends ReviewTraceCommitRef {
  sessions: string[];
}

/** Resolves a Git revision to its SHA, retaining the supplied revision when resolution fails. */
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

/** Returns valid, unique Agent-Session trailers for a revision, or an empty list when Git fails. */
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

/** Reads valid, unique session trailers from all repository refs without consulting trace storage. */
export async function listRepositoryTraceSessionIds(
  cwd: string,
): Promise<string[]> {
  const result = await gitAt(
    cwd,
    [
      "log",
      "--all",
      "--no-show-signature",
      "--format=%(trailers:key=Agent-Session,valueonly,separator=%x1f)",
    ],
    { allowFailure: true },
  );

  if (!result.ok) return [];

  return deduplicateStrings(
    result.stdout
      .split(/[\n\x1f]+/)
      .map((value) => value.trim())
      .filter((value) => sessionIdSchema.safeParse(value).success),
  );
}

/** Reads a revision subject and extracts its trailing pull request number, or returns null. */
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

/** Extracts a trailing (#number) from a subject without consulting Git. */
export function subjectPullNumber(subject: string): number | null {
  const match = /\(#(\d+)\)$/.exec(subject);

  return match ? Number(match[1]) : null;
}

/** Reads the repository author email and current branch, returning null fields outside a worktree. */
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

/** Reads commit subjects and valid session trailers in the requested range without consulting trace storage. */
export async function commitsWithTrailers(input: {
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

    const sessions = new Set(
      trailerFields.flatMap((field) => field.split("\n")),
    )
      .values()
      .map((value) => value.trim())
      .filter((value) => sessionIdSchema.safeParse(value).success)
      .toArray();

    commits.push({ sha, subject: subject ?? "", sessions });
  }

  return commits;
}

/** Fetches a pull request head and collects its unique session trailers, returning an empty list if Git cannot resolve the branch. */
export async function prScanTrailerSessions(
  cwd: string,
  commit: string,
  pr: number,
): Promise<string[]> {
  const fetchRes = await gitAt(
    cwd,
    ["fetch", "--quiet", "origin", `refs/pull/${pr}/head`],
    { allowFailure: true },
  );

  if (!fetchRes.ok) return [];

  let revListRes = await gitAt(
    cwd,
    ["rev-list", "FETCH_HEAD", "--not", `${commit}^`],
    { allowFailure: true },
  );

  if (!revListRes.ok) {
    revListRes = await gitAt(
      cwd,
      ["rev-list", "FETCH_HEAD", "--not", `${commit}~1`],
      { allowFailure: true },
    );
  }

  if (!revListRes.ok) {
    revListRes = await gitAt(cwd, ["rev-list", "FETCH_HEAD"], {
      allowFailure: true,
    });
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

/** Reports whether a path resolves to a regular file, returning false for filesystem errors. */
export function isFile(targetPath: string): boolean {
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

/** Collects regular files recursively, retaining files found before a directory read fails. */
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
