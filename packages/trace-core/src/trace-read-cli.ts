import type { Writable } from "node:stream";

import {
  type AgentTraceEvent,
  extractTraceEventText,
} from "./agent-trace-parser";
import { errorMessage } from "./error-message";
import {
  type ReviewTraceBlameLookupResult,
  type ReviewTraceCommitLookupResult,
  type ReviewTraceSessionDescriptor,
  describeTraceSession,
  inferRepoFromGit,
  listRepositoryTraceSessionIds,
  listWhiteboardTraceSessions,
  loadWhiteboardAgentTrace,
  lookupReviewTraceBlame,
  lookupReviewTraceCommit,
  lookupReviewTraceSession,
  parseRepo,
  pullReviewTraceCorpus,
} from "./review-agent-traces";
import { traceCommandPrefix } from "./trace-command";
import { resolveTraceStorage } from "./trace-storage/resolve";
import type { TraceStorage, TraceStorageKind } from "./trace-storage/types";

/**
 * The repository-scoped read commands. A caller that knows a Review passes
 * its change range as a value; this file never opens the Review store.
 */

/** A Review's change range, resolved by the caller from the Review store. */
export interface TraceWhiteboardScope {
  uuid: string;
  repoRoot: string;
  baseCommit: string;
  headCommit: string;
}

export type TraceListScope =
  | { commit: string }
  | { review: TraceWhiteboardScope };

export type TracePullScope =
  | TraceListScope
  | { session: string }
  | { repository: true };

/**
 * The store a read command uses: the explicit `--storage` override for this
 * one operation, or the machine's selection when none is given. An override
 * never changes the selection, capture settings, or consent.
 */
export async function resolveTraceReadStorage(
  override: TraceStorageKind | undefined,
  cwd: string,
): Promise<TraceStorage | null | undefined> {
  if (!override) return undefined;

  return resolveTraceStorage({ cwd, override });
}

async function listSessionsForReviewScope(
  review: TraceWhiteboardScope,
  storage?: TraceStorage | null,
) {
  return listWhiteboardTraceSessions({
    rootPath: review.repoRoot,
    baseCommit: review.baseCommit,
    headCommit: review.headCommit,
    storage,
  });
}

export async function runTraceList(input: {
  cwd: string;
  scope: TraceListScope;
  storage?: TraceStorageKind;
  resolvedStorage?: TraceStorage | null;
  json?: boolean;
  stdout: Writable;
}): Promise<number> {
  const storage =
    "resolvedStorage" in input
      ? input.resolvedStorage
      : await resolveTraceReadStorage(input.storage, input.cwd);

  let scope: { review: string } | { commit: string };
  let sessions: ReviewTraceSessionDescriptor[];
  let emptyExitCode = 0;

  if ("commit" in input.scope) {
    const resolution = await lookupReviewTraceCommit({
      cwd: input.cwd,
      sha: input.scope.commit,
      storage,
    });

    scope = { commit: resolution.commit };
    sessions = await Promise.all(
      resolution.sessions.map((sessionId) =>
        describeTraceSession(
          {
            sessionId,
            commits: [{ sha: resolution.commit, subject: "" }],
          },
          storage,
        ),
      ),
    );
    emptyExitCode = 1;
  } else {
    scope = { review: input.scope.review.uuid };
    sessions = await listSessionsForReviewScope(input.scope.review, storage);
  }

  const publicSessions = sessions.map((session) => ({
    id: session.sessionId,
    harness: session.harness,
    available: session.available,
    traces: ["main", ...(session.subagents ?? [])],
    commits: session.commits,
  }));

  if (input.json) {
    input.stdout.write(
      `${JSON.stringify({ ...scope, sessions: publicSessions })}\n`,
    );

    return sessions.length === 0 ? emptyExitCode : 0;
  }

  if (sessions.length === 0) {
    const label =
      "review" in scope ? `review ${scope.review}` : `commit ${scope.commit}`;

    input.stdout.write(`No agent sessions recorded for ${label}.\n`);

    return emptyExitCode;
  }

  for (const session of publicSessions) {
    input.stdout.write(
      `${session.id}  (${session.harness}, ${
        session.available ? "S3/R2 synced" : "not synced"
      })\n`,
    );

    for (const commit of session.commits) {
      input.stdout.write(
        `  commit ${commit.sha.slice(0, 9)}  ${commit.subject}\n`,
      );
    }

    for (const name of session.traces.slice(1)) {
      input.stdout.write(`  trace ${name}\n`);
    }
  }

  return 0;
}

export async function runTraceShow(input: {
  cwd: string;
  sessionId: string;
  trace?: string;
  eventIndex?: number;
  kind?: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const traceName = input.trace === "main" ? undefined : input.trace;

  const loaded = await loadWhiteboardAgentTrace({
    sessionId: input.sessionId,
    trace: traceName,
    cwd: input.cwd,
    storage: await resolveTraceReadStorage(input.storage, input.cwd),
  });

  if (!loaded) {
    throw new Error(
      `No transcript is available for session ${input.sessionId}${traceName ? ` (trace ${traceName})` : ""}.`,
    );
  }

  const { trace } = loaded;

  if (input.eventIndex !== undefined) {
    const event = trace.events[input.eventIndex];

    if (!event) {
      throw new Error(
        `Event ${input.eventIndex} is out of range. Session ${input.sessionId} has ${trace.events.length} events.`,
      );
    }

    const text = extractTraceEventText(event);

    if (input.json) {
      const traceQuoteProps = {
        sessionId: input.sessionId,
        event: input.eventIndex,
        trace: traceName || undefined,
      };

      input.stdout.write(
        `${JSON.stringify({
          session: input.sessionId,
          trace: traceName ?? "main",
          event: input.eventIndex,
          kind: event.kind,
          text,
          trace_quote_props: traceQuoteProps,
        })}\n`,
      );

      return 0;
    }

    input.stdout.write(`${text}\n`);

    return 0;
  }

  const rows = trace.events
    .map((event, index) => ({ event, index }))
    .filter((row) => !input.kind || row.event.kind === input.kind);

  if (input.json) {
    input.stdout.write(
      `${JSON.stringify({
        session: input.sessionId,
        trace: traceName ?? "main",
        harness: trace.harness,
        title: trace.title,
        cache: loaded.cacheStatus,
        events: rows.map(({ event, index }) => ({
          event: index,
          kind: event.kind,
          summary: compactEventLine(event),
        })),
      })}\n`,
    );

    return 0;
  }

  input.stdout.write(
    `# session ${input.sessionId}${traceName ? ` (trace ${traceName})` : ""} (${trace.harness}) — ${
      trace.title ?? "untitled"
    }\n# ${trace.events.length} events${input.kind ? ` (${rows.length} shown, kind=${input.kind})` : ""}${
      loaded.cacheStatus === "current" ? "" : ` (${loaded.cacheStatus} copy)`
    }\n`,
  );

  for (const { event, index } of rows) {
    input.stdout.write(
      `${String(index).padStart(4, " ")}  ${compactEventLine(event)}\n`,
    );
  }

  return 0;
}

/** Which sessions a `trace pull` selected, echoed back in its JSON report. */
type TracePullReport =
  | { review: string }
  | { commit: string }
  | { session: string }
  | { repository: string };

export async function runTracePull(input: {
  cwd: string;
  scope: TracePullScope;
  repo?: string;
  mainOnly?: boolean;
  storage?: TraceStorageKind;
  resolvedStorage?: TraceStorage | null;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  try {
    const storage =
      "resolvedStorage" in input
        ? input.resolvedStorage
        : await resolveTraceReadStorage(input.storage, input.cwd);

    let scope: TracePullReport;
    let sessions: Array<{ id: string; traces?: string[] }>;
    let repoRoot = input.cwd;

    if ("review" in input.scope) {
      const review = input.scope.review;
      repoRoot = review.repoRoot;
      const refs = await listSessionsForReviewScope(review, storage);
      scope = { review: review.uuid };
      sessions = refs.map((ref) => ({
        id: ref.sessionId,
        traces: ref.subagents,
      }));
    } else if ("commit" in input.scope) {
      const resolution = await lookupReviewTraceCommit({
        cwd: input.cwd,
        sha: input.scope.commit,
        storage,
      });

      scope = { commit: resolution.commit };
      sessions = resolution.sessions.map((id) => ({ id }));
    } else if ("session" in input.scope) {
      scope = { session: input.scope.session };
      sessions = [{ id: input.scope.session }];
    } else {
      sessions = (await listRepositoryTraceSessionIds(input.cwd)).map((id) => ({
        id,
      }));
      scope = { repository: input.repo ?? "current" };
    }

    const repo = input.repo
      ? parseRepo(input.repo)
      : await inferRepoFromGit(repoRoot);

    const result = await pullReviewTraceCorpus({
      repo,
      sessions,
      mainOnly: input.mainOnly,
      cwd: repoRoot,
      storage,
    });

    const output = {
      scope,
      corpus_root: result.corpusRoot,
      repository: result.repository,
      sessions: result.sessions,
      unavailable_sessions: result.unavailableSessions,
      events: result.events,
      files: result.files,
      paths: result.paths,
    };

    if (input.json) {
      input.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      input.stdout.write(
        `Pulled ${result.sessions.length} session(s) into ${result.corpusRoot}.\n`,
      );
      input.stdout.write(
        `Materialized ${result.files} normalized trace file(s) with ${result.events} event(s) for ${result.repository}.\n`,
      );

      for (const filePath of result.paths) {
        input.stdout.write(`  ${filePath}\n`);
      }

      if (result.unavailableSessions.length > 0) {
        input.stderr.write(
          `Unavailable sessions: ${result.unavailableSessions.join(", ")}\n`,
        );
      }
    }

    return sessions.length > 0 && result.sessions.length === 0 ? 1 : 0;
  } catch (error) {
    input.stderr.write(`trace pull error: ${errorMessage(error)}\n`);

    return 1;
  }
}

export async function runTraceLookupCommit(input: {
  cwd: string;
  sha: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
}): Promise<number> {
  const result = await lookupReviewTraceCommit({
    cwd: input.cwd,
    sha: input.sha,
    storage: await resolveTraceReadStorage(input.storage, input.cwd),
  });

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    return result.sessions.length === 0 ? 1 : 0;
  }

  printCommitResolution(result, input.stdout);

  return result.sessions.length === 0 ? 1 : 0;
}

export async function runTraceBlame(input: {
  cwd: string;
  file: string;
  lines?: string;
  history?: boolean;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  let result: ReviewTraceBlameLookupResult;

  try {
    result = await lookupReviewTraceBlame({
      cwd: input.cwd,
      file: input.file,
      lines: input.lines,
      history: input.history,
      storage: await resolveTraceReadStorage(input.storage, input.cwd),
    });
  } catch (err: unknown) {
    input.stderr.write(`trace blame error: ${errorMessage(err)}\n`);

    return 1;
  }

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    const hasAnySessions = result.resolutions.some(
      (r) => r.sessions.length > 0,
    );

    return hasAnySessions ? 0 : 1;
  }

  if (result.resolutions.length === 0) {
    input.stderr.write(`no commits found for ${input.file}\n`);

    return 1;
  }

  for (const resolution of result.resolutions) {
    printCommitResolution(resolution, input.stdout);
  }

  const hasAnySessions = result.resolutions.some((r) => r.sessions.length > 0);

  return hasAnySessions ? 0 : 1;
}

export async function runTraceLookupSession(input: {
  cwd: string;
  sessionId: string;
  storage?: TraceStorageKind;
  json?: boolean;
  stdout: Writable;
}): Promise<number> {
  const result = await lookupReviewTraceSession({
    sessionId: input.sessionId,
    storage: await resolveTraceReadStorage(input.storage, input.cwd),
  });

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    return result.meta === null && !result.has_raw_trace ? 1 : 0;
  }

  if (result.meta === null && !result.has_raw_trace) {
    input.stdout.write(`no session meta found for ${result.session}\n`);

    return 1;
  }

  if (result.meta) {
    input.stdout.write(`${JSON.stringify(result.meta, null, 2)}\n`);
  } else {
    input.stdout.write(`Session: ${result.session}\n`);
  }

  if (result.has_raw_trace) {
    input.stdout.write(
      `  raw trace: by-session/${result.session}/trace.jsonl\n`,
    );
  }

  if (result.subagents.length > 0) {
    input.stdout.write(`  subagents: ${result.subagents.join(", ")}\n`);
  }

  return 0;
}

function printCommitResolution(
  resolution: ReviewTraceCommitLookupResult,
  stdout: Writable,
): void {
  const shortCommit = resolution.commit.slice(0, 12);

  if (resolution.sessions.length === 0) {
    stdout.write(
      `${shortCommit}  no agent sessions found (source checked: trailer, index, pr-scan)\n`,
    );

    return;
  }

  const prSuffix = resolution.pr !== null ? ` PR #${resolution.pr}` : "";
  stdout.write(
    `${shortCommit}  → ${resolution.sessions.length} session(s) via ${resolution.source}${prSuffix}\n`,
  );

  for (const session of resolution.sessions) {
    const meta = resolution.session_meta?.[session];

    const metaSuffix = meta
      ? `  (${meta.branch || "?"}, ${meta.author || "?"})`
      : "";

    stdout.write(`    ${session}${metaSuffix}\n`);
    stdout.write(`      trace: by-session/${session}/trace.jsonl\n`);
    stdout.write(
      `      pull for FFF: ${traceCommandPrefix()} pull --agent-session ${session}\n`,
    );
  }
}

function compactEventLine(event: AgentTraceEvent): string {
  const oneLine = (text: string, limit: number): string => {
    const collapsed = text.replace(/\s+/g, " ").trim();

    return collapsed.length > limit
      ? `${collapsed.slice(0, limit - 1)}…`
      : collapsed;
  };

  if (event.kind === "user") return `user       ${oneLine(event.text, 160)}`;

  if (event.kind === "assistant") {
    return `${event.thinking ? "thinking  " : "assistant "} ${oneLine(event.markdown, 160)}`;
  }

  if (event.kind === "separator") return `separator  ${event.label}`;

  const counts = [
    event.additions ? `+${event.additions}` : null,
    event.deletions ? `−${event.deletions}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return `tool       ${event.verb} ${oneLine(event.title, 120)}${
    counts ? ` ${counts}` : ""
  }${event.filePath ? ` [${event.filePath}]` : ""}`;
}
