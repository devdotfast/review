import {
  type AgentTraceEvent,
  extractTraceEventText,
} from "./agent-trace-parser";
import {
  type ReviewTraceBlameLookupResult,
  type ReviewTraceCommitLookupResult,
  type ReviewTraceSessionDescriptor,
  checkReviewTraceDoctor,
  describeTraceSession,
  inferRepoFromGit,
  listRepositoryTraceSessionIds,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  lookupReviewTraceBlame,
  lookupReviewTraceCommit,
  lookupReviewTraceSession,
  parseRepo,
  pullReviewTraceCorpus,
  syncReviewTrace,
} from "./review-agent-traces";
import { reviewUuidForManagedCheckout } from "./review-head-checkout";
import { type StoredReview, findReview, listReviews } from "./review-home";
import { resolveReviewRepoRootFromStore } from "./review-worktree-target";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import { runReviewTraceHook } from "./trace-hook-runner";
import { traceMachineStatus } from "./trace-machine-setup";
import {
  disableTraceRepository,
  enableTraceRepository,
  repairTraceRepository,
  traceRepositoryStatus,
} from "./trace-repository-hooks";

export { runReviewTraceGitHook, runReviewTraceHook };

export async function runReviewTraceStatus(input: {
  cwd: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  const machine = await traceMachineStatus();
  const repository = await traceRepositoryStatus(input.cwd);
  input.stdout.write(
    `Trace capture: ${machine.enabled ? "enabled" : "disabled"}\n`,
  );
  input.stdout.write(`Repository: ${repository.message}\n`);
  const doctor = await checkReviewTraceDoctor({ cwd: input.cwd });
  input.stdout.write(`Checking trace configuration (${doctor.envPath})…\n`);

  if (!doctor.ok && !doctor.config) {
    input.stderr.write(
      `trace status: ${doctor.error ?? "No trace configuration found. Use Review Agent Setup to configure trace capture."}\n`,
    );
    return 1;
  }

  if (doctor.config) {
    input.stdout.write(`  Endpoint: ${doctor.config.endpoint}\n`);
    input.stdout.write(`  Bucket:   ${doctor.config.bucket}\n`);
    input.stdout.write(
      `  Key:      ${doctor.config.accessKeyId.slice(0, 6)}…\n`,
    );
  }

  if (doctor.reachable && doctor.config) {
    input.stdout.write(`✓ R2 bucket "${doctor.config.bucket}" is reachable.\n`);
    return 0;
  }

  if (doctor.config) {
    input.stderr.write(
      `✗ Cannot reach R2 bucket "${doctor.config.bucket}": ${doctor.error ?? "unknown error"}\n`,
    );
  }
  return 1;
}

export async function runReviewTraceEnable(input: {
  cwd: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  if (!(await traceMachineStatus()).enabled) {
    input.stderr.write(
      "trace enable: Trace capture is not enabled. Use Review Agent Setup first.\n",
    );
    return 1;
  }
  const result = await enableTraceRepository({ cwd: input.cwd });
  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);
  return result.enabled ? 0 : 1;
}

export async function runReviewTraceDisable(input: {
  cwd: string;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  const result = await disableTraceRepository({ cwd: input.cwd });
  input.stdout.write(`${result.message}\n`);
  return result.repository ? 0 : 1;
}

export async function runReviewTraceRepair(input: {
  cwd: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  if (!(await traceMachineStatus()).enabled) {
    input.stderr.write(
      "trace repair: Trace capture is not enabled. Use Review Agent Setup first.\n",
    );
    return 1;
  }
  const result = await repairTraceRepository({ cwd: input.cwd });
  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);
  return result.enabled ? 0 : 1;
}

export const runReviewTraceDoctor = runReviewTraceStatus;

async function listSessionsForReview(review: StoredReview) {
  const repoRootPath = resolveReviewRepoRootFromStore(review.dir);
  const record = review.review;
  const headCommit = record.sourceCommit ?? record.baseCommit;
  return listReviewTraceSessions({
    rootPath: repoRootPath,
    baseCommit: record.baseCommit,
    headCommit,
  });
}

export async function runReviewTraceList(input: {
  cwd: string;
  reviewUuid?: string;
  commitSha?: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  let scope: { review: string } | { commit: string };
  let sessions: ReviewTraceSessionDescriptor[];
  let emptyExitCode = 0;
  if (input.commitSha) {
    const resolution = await lookupReviewTraceCommit({
      cwd: input.cwd,
      sha: input.commitSha,
    });
    scope = { commit: resolution.commit };
    sessions = await Promise.all(
      resolution.sessions.map((sessionId) =>
        describeTraceSession({
          sessionId,
          commits: [{ sha: resolution.commit, subject: "" }],
        }),
      ),
    );
    emptyExitCode = 1;
  } else {
    const review = await resolveTraceReview(input.cwd, input.reviewUuid);
    scope = { review: review.review.uuid };
    sessions = await listSessionsForReview(review);
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
        session.available ? "R2 synced" : "not synced"
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

export async function runReviewTraceShow(input: {
  cwd: string;
  sessionId: string;
  trace?: string;
  eventIndex?: number;
  // Several events in one process: the agent otherwise launches the CLI
  // once per event it wants to read.
  eventIndexes?: number[];
  kind?: string;
  refresh?: boolean;
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  const traceName = input.trace === "main" ? undefined : input.trace;
  const loaded = await loadReviewAgentTrace({
    sessionId: input.sessionId,
    trace: traceName,
    cwd: input.cwd,
    refresh: input.refresh,
  });
  if (!loaded) {
    throw new Error(
      `No transcript is available for session ${input.sessionId}${traceName ? ` (trace ${traceName})` : ""}.`,
    );
  }
  const { trace } = loaded;
  const requested =
    input.eventIndexes ??
    (input.eventIndex !== undefined ? [input.eventIndex] : undefined);
  if (requested && requested.length > 1) {
    const events = requested.map((index) => {
      const event = trace.events[index];
      if (!event) {
        throw new Error(
          `Event ${index} is out of range. Session ${input.sessionId} has ${trace.events.length} events.`,
        );
      }
      return { index, event, text: extractTraceEventText(event) };
    });
    if (input.json) {
      input.stdout.write(
        `${JSON.stringify({
          session: input.sessionId,
          trace: traceName ?? "main",
          events: events.map(({ index, event, text }) => ({
            event: index,
            kind: event.kind,
            text,
            trace_quote_props: {
              sessionId: input.sessionId,
              event: index,
              ...(traceName ? { trace: traceName } : {}),
            },
          })),
        })}\n`,
      );
      return 0;
    }
    for (const { index, event, text } of events) {
      input.stdout.write(`=== event ${index} (${event.kind}) ===\n${text}\n\n`);
    }
    return 0;
  }
  if (requested && requested.length === 1) {
    input.eventIndex = requested[0];
  }
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
        ...(traceName ? { trace: traceName } : {}),
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
    }\n# ${trace.events.length} events${input.kind ? ` (${rows.length} shown, kind=${input.kind})` : ""}\n`,
  );
  for (const { event, index } of rows) {
    input.stdout.write(
      `${String(index).padStart(4, " ")}  ${compactEventLine(event)}\n`,
    );
  }
  return 0;
}

export async function runReviewTracePull(input: {
  cwd: string;
  repo?: string;
  reviewUuid?: string;
  commitSha?: string;
  session?: string;
  mainOnly?: boolean;
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  try {
    let scope: Record<string, string>;
    let sessions: Array<{ id: string; traces?: string[] }>;
    let repoRoot = input.cwd;

    if (input.reviewUuid) {
      const review = await resolveTraceReview(input.cwd, input.reviewUuid);
      repoRoot = resolveReviewRepoRootFromStore(review.dir);
      const refs = await listSessionsForReview(review);
      scope = { review: review.review.uuid };
      sessions = refs.map((ref) => ({
        id: ref.sessionId,
        traces: ref.subagents,
      }));
    } else if (input.commitSha) {
      const resolution = await lookupReviewTraceCommit({
        cwd: input.cwd,
        sha: input.commitSha,
      });
      scope = { commit: resolution.commit };
      sessions = resolution.sessions.map((id) => ({ id }));
    } else if (input.session) {
      scope = { session: input.session };
      sessions = [{ id: input.session }];
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
    input.stderr.write(
      `trace pull error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

export async function runReviewTraceLookupCommit(input: {
  cwd: string;
  sha: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  const result = await lookupReviewTraceCommit({
    cwd: input.cwd,
    sha: input.sha,
  });

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.sessions.length === 0 ? 1 : 0;
  }

  printCommitResolution(result, input.stdout);
  return result.sessions.length === 0 ? 1 : 0;
}

export async function runReviewTraceBlame(input: {
  cwd: string;
  file: string;
  lines?: string;
  history?: boolean;
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  let result: ReviewTraceBlameLookupResult;
  try {
    result = await lookupReviewTraceBlame({
      cwd: input.cwd,
      file: input.file,
      lines: input.lines,
      history: input.history,
    });
  } catch (err: unknown) {
    input.stderr.write(
      `trace blame error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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

export const runReviewTraceLookupBlame = runReviewTraceBlame;

export async function runReviewTraceLookupSession(input: {
  cwd: string;
  sessionId: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  const result = await lookupReviewTraceSession({
    sessionId: input.sessionId,
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
  stdout: NodeJS.WriteStream,
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
      `      pull for FFF: review trace pull --session ${session}\n`,
    );
  }
}

export async function runReviewTraceSync(input: {
  cwd: string;
  sessionId: string;
  repo?: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  const result = await syncReviewTrace({
    sessionId: input.sessionId,
    cwd: input.cwd,
    repo: input.repo,
  });

  if (input.json) {
    input.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  for (const upload of result.uploads) {
    input.stdout.write(
      `${upload.blob}  ${upload.bytes_stored} bytes  ${upload.status}\n`,
    );
  }
  input.stdout.write(
    `Updated meta for session ${result.session} in ${result.repo}.\n`,
  );
  return 0;
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

async function resolveTraceReview(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<StoredReview> {
  const managedReviewUuid = await reviewUuidForManagedCheckout(cwd);
  const wantedUuid = reviewUuid ?? managedReviewUuid ?? undefined;
  if (wantedUuid) {
    const review = await findReview(wantedUuid);
    if (!review) throw new Error(`Review not found: ${wantedUuid}`);
    return review;
  }
  const candidates = (await listReviews({ worktreePath: cwd })).reviews.filter(
    (review) => review.review.status !== "rejected",
  );
  if (candidates.length === 0) {
    throw new Error("No review found for this worktree.");
  }
  if (candidates.length > 1) {
    throw new Error("Multiple reviews require --review <uuid>.");
  }
  return candidates[0];
}
