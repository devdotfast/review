import type { Writable } from "node:stream";

import { git } from "@dev.fast/local-vcs";

import {
  installClaudeTraceHook,
  installCodexTraceHook,
  installPiTraceExtension,
} from "./agent-trace-hooks";
import {
  type AgentTraceEvent,
  extractTraceEventText,
} from "./agent-trace-parser";
import type { TraceQuoteProps } from "./authoring";
import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import {
  type ReviewTraceBlameLookupResult,
  type ReviewTraceCommitLookupResult,
  type ReviewTraceSessionDescriptor,
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
import {
  DEFAULT_STORE_ORIGIN,
  readStoreAuth,
  requireStoreClient,
} from "./store-auth";
import { StoreApiError, type StoreClient } from "./store-client";
import { readActiveTraceSessions } from "./trace-agent-sessions";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import {
  resolveAllowedTraceRepository,
  runReviewTraceHook,
} from "./trace-hook-runner";
import {
  enableTraceRepository,
  repairTraceRepository,
} from "./trace-repository-hooks";
import {
  type TraceStoreTransport,
  createHttpTraceStoreTransport,
} from "./trace-store-transport";
import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

export {
  resolveAllowedTraceRepository,
  runReviewTraceGitHook,
  runReviewTraceHook,
};

/** The Git-path-tracked agent sessions still active for this repository. */
async function pendingTraceSessions(cwd: string): Promise<string[]> {
  const gitPathResult = await git(
    cwd,
    ["rev-parse", "--git-path", "agent-session"],
    { allowFailure: true },
  );
  const sessionFilePath = gitPathResult.ok ? gitPathResult.stdout.trim() : "";
  if (!sessionFilePath) return [];
  const sessions = await readActiveTraceSessions(sessionFilePath);
  return [...sessions.keys()];
}

export async function runReviewTraceOnboard(input: {
  cwd: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  client?: StoreClient;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await inferRepoFromGit(input.cwd));
  } catch (error) {
    return failWithJsonError(output, "onboard", errorMessage(error));
  }
  let client: StoreClient;
  try {
    client = input.client ?? (await requireStoreClient());
  } catch (error) {
    return failWithJsonError(output, "onboard", errorMessage(error));
  }
  let store: Awaited<ReturnType<StoreClient["createStore"]>>;
  try {
    store = await client.createStore({ owner, name: repo });
  } catch (error) {
    if (error instanceof StoreApiError && error.code === "forbidden") {
      return failWithJsonError(
        output,
        "onboard",
        `You need write access to ${owner}/${repo} to onboard it.`,
      );
    }
    return failWithJsonError(output, "onboard", errorMessage(error));
  }
  emitJsonEvent(output, {
    event: "trace.onboard",
    repositoryId: store.repositoryId,
    displayName: store.displayName,
    created: store.created === true,
  });
  const stream = humanStream(output);
  stream.write(`Onboarded ${store.displayName} (id ${store.repositoryId}).\n`);
  stream.write(
    "Run `review trace allow .` to send traces from this repository.\n",
  );
  return 0;
}

export async function runReviewTraceAllow(input: {
  cwd: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  client?: StoreClient;
  homeDir?: string;
  harnessHooks?: boolean;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await inferRepoFromGit(input.cwd));
  } catch (error) {
    return failWithJsonError(output, "allow", errorMessage(error));
  }
  const name = `${owner}/${repo}`;
  let client: StoreClient;
  try {
    client = input.client ?? (await requireStoreClient());
  } catch (error) {
    return failWithJsonError(output, "allow", errorMessage(error));
  }
  let store: Awaited<ReturnType<StoreClient["findStore"]>>;
  try {
    store = await client.findStore({ owner, name: repo });
  } catch (error) {
    return failWithJsonError(output, "allow", errorMessage(error));
  }
  if (!store) {
    return failWithJsonError(
      output,
      "allow",
      `${name} is not onboarded. Run \`review trace onboard\` first.`,
    );
  }

  if (input.harnessHooks !== false) {
    await installClaudeTraceHook(input.homeDir);
    await installCodexTraceHook(input.homeDir);
    await installPiTraceExtension(input.homeDir);
  }
  await enableTraceRepository({ cwd: input.cwd, homeDir: input.homeDir });
  const auth = await readStoreAuth();
  const storeOrigin = auth?.origin ?? DEFAULT_STORE_ORIGIN;
  await allowTraceRepository({
    repositoryId: store.repositoryId,
    name: store.displayName,
    store: storeOrigin,
  });

  emitJsonEvent(output, {
    event: "trace.allow",
    repositoryId: store.repositoryId,
    name: store.displayName,
    store: storeOrigin,
  });
  humanStream(output).write(
    `Traces from ${store.displayName} will be published to ${storeOrigin}.\n`,
  );
  return 0;
}

export async function runReviewTraceDeny(input: {
  cwd: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await inferRepoFromGit(input.cwd));
  } catch (error) {
    return failWithJsonError(output, "deny", errorMessage(error));
  }
  const name = `${owner}/${repo}`;
  const removed = await denyTraceRepository(name);
  emitJsonEvent(output, { event: "trace.deny", name, removed });
  humanStream(output).write(
    removed
      ? `${name} will no longer publish traces.\n`
      : `${name} was not allowed to publish traces.\n`,
  );
  return 0;
}

export async function runReviewTraceStatus(input: {
  cwd: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  const auth = await readStoreAuth();
  const config = await readTraceUserConfig();
  const repositories = config.repositories.map((entry) => ({
    repositoryId: entry.repositoryId,
    name: entry.name,
    store: entry.store,
  }));

  let currentRepository: {
    name: string;
    repositoryId: number | null;
    allowed: boolean;
  } | null = null;
  try {
    const { owner, repo } = await inferRepoFromGit(input.cwd);
    const name = `${owner}/${repo}`;
    const entry = findTraceRepository(config, name);
    currentRepository = entry
      ? { name, repositoryId: entry.repositoryId, allowed: true }
      : { name, repositoryId: null, allowed: false };
  } catch {
    currentRepository = null;
  }

  const pendingSessions = await pendingTraceSessions(input.cwd);

  emitJsonEvent(output, {
    event: "trace.status",
    loggedIn: auth !== null,
    login: auth?.login ?? null,
    store: auth?.origin ?? null,
    repositories,
    currentRepository,
    pendingSessions,
  });

  const stream = humanStream(output);
  stream.write(
    auth
      ? `You are logged in to ${auth.origin} as ${auth.login}.\n`
      : "You are not logged in. Run `review login` first.\n",
  );
  if (repositories.length === 0) {
    stream.write("No repository is allowed to publish traces.\n");
  } else {
    for (const repository of repositories) {
      stream.write(
        `Allowed repository: ${repository.name} (id ${repository.repositoryId}).\n`,
      );
    }
  }
  if (currentRepository === null) {
    stream.write("This directory has no GitHub remote to check.\n");
  } else if (currentRepository.allowed) {
    stream.write(
      `This repository (${currentRepository.name}) is allowed to publish traces.\n`,
    );
  } else {
    stream.write(
      `This repository (${currentRepository.name}) is not allowed. Run \`review trace allow .\`.\n`,
    );
  }
  if (pendingSessions.length === 0) {
    stream.write("No agent session is pending.\n");
  } else {
    for (const sessionId of pendingSessions) {
      stream.write(`Pending agent session: ${sessionId}.\n`);
    }
  }
  return 0;
}

export async function runReviewTraceRepair(input: {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const result = await repairTraceRepository({ cwd: input.cwd });
  (result.enabled ? input.stdout : input.stderr).write(`${result.message}\n`);
  return result.enabled ? 0 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  stdout: Writable;
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

export async function runReviewTraceShow(input: {
  cwd: string;
  sessionId: string;
  trace?: string;
  eventIndex?: number;
  kind?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): Promise<number> {
  const traceName = input.trace === "main" ? undefined : input.trace;
  const loaded = await loadReviewAgentTrace({
    sessionId: input.sessionId,
    trace: traceName,
    cwd: input.cwd,
    onWarning: storeWarningSink(input.stderr),
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
      const traceQuoteProps: TraceQuoteProps = {
        sessionId: input.sessionId,
        event: input.eventIndex,
      };
      if (traceName) traceQuoteProps.trace = traceName;
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

/** Which sessions a `trace pull` selected, echoed back in its JSON report. */
type TracePullScope =
  | { review: string }
  | { commit: string }
  | { session: string }
  | { repository: string };

export async function runReviewTracePull(input: {
  cwd: string;
  repo?: string;
  reviewUuid?: string;
  commitSha?: string;
  session?: string;
  mainOnly?: boolean;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  client?: StoreClient;
  transport?: TraceStoreTransport;
}): Promise<number> {
  try {
    let scope: TracePullScope;
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
      cwd: repoRoot,
      transport: traceStoreTransport(input),
      onWarning: storeWarningSink(input.stderr),
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
  stdout: Writable;
  stderr?: Writable;
  client?: StoreClient;
  transport?: TraceStoreTransport;
  repositoryId?: number;
}): Promise<number> {
  const result = await lookupReviewTraceCommit({
    cwd: input.cwd,
    sha: input.sha,
    transport: traceStoreTransport(input),
    repositoryId: input.repositoryId,
    ...(input.stderr ? { onWarning: storeWarningSink(input.stderr) } : {}),
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
  stdout: Writable;
  stderr?: Writable;
  client?: StoreClient;
  transport?: TraceStoreTransport;
  repositoryId?: number;
}): Promise<number> {
  const result = await lookupReviewTraceSession({
    sessionId: input.sessionId,
    cwd: input.cwd,
    transport: traceStoreTransport(input),
    repositoryId: input.repositoryId,
    ...(input.stderr ? { onWarning: storeWarningSink(input.stderr) } : {}),
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
    input.stdout.write("  raw trace: stored\n");
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
    stdout.write(`    ${session}\n`);
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
  stdout: Writable;
  stderr: Writable;
  client?: StoreClient;
  transport?: TraceStoreTransport;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  let result: Awaited<ReturnType<typeof syncReviewTrace>>;
  try {
    result = await syncReviewTrace({
      sessionId: input.sessionId,
      cwd: input.cwd,
      repo: input.repo,
      transport: traceStoreTransport(input),
    });
  } catch (error) {
    return failWithJsonError(output, "trace.sync", errorMessage(error));
  }

  emitJsonEvent(output, {
    event: "trace.sync",
    sessionId: result.session,
    repositoryId: result.repositoryId,
    stored: result.stored,
    objects: result.objects,
    commits: result.commits,
  });
  const stream = humanStream(output);
  for (const object of result.objects) {
    stream.write(`${object}  stored\n`);
  }
  stream.write(
    `Shipped session ${result.session} of ${result.repo} to the trace store.\n`,
  );
  return 0;
}

/** Sends one store failure line to the command's error channel. */
function storeWarningSink(stderr: Writable): (message: string) => void {
  return (message: string) => {
    stderr.write(`${message}\n`);
  };
}

/**
 * The transport a trace command was given, if any. A read command that gets
 * none still works from the local corpus, so no command demands a login here.
 */
function traceStoreTransport(input: {
  client?: StoreClient;
  transport?: TraceStoreTransport;
}): TraceStoreTransport | undefined {
  if (input.transport) return input.transport;
  return input.client ? createHttpTraceStoreTransport(input.client) : undefined;
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
