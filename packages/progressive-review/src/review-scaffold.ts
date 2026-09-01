import path from "node:path";

import {
  changeIdentityForRevision,
  currentHead,
  devfastPrepareCommands,
  diffNameStatusTrees,
  mergeBase,
  resolveRevision,
} from "@dev.fast/local-vcs";
import type {
  ReviewAgentTraceSession,
  ReviewSourceIdentity,
} from "@dev.fast/review-protocol";

import {
  authoringSessionKey,
  resolveAuthoringSessionRef,
} from "./authoring-session";
import {
  type ReviewTracePullSessionResult,
  inferRepoFromGit,
  listReviewTraceSessions,
  pullReviewTraceCorpus,
} from "./review-agent-traces";
import { isPositionalChangeIdentity } from "./review-change-scope";
import { removeReviewManagedCheckouts } from "./review-head-checkout";
import {
  DISABLED_REVIEW_SOURCE_SESSION,
  type StoredReview,
  createReviewDir,
  createReviewUuid,
  listReviews,
  updateReviewPins,
} from "./review-home";
import type { ReviewInfoEvent } from "./review-info";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import { createReviewSourceAgentSession } from "./review-source-agent-session";
import {
  deleteReviewSourceHeadRef,
  pinReviewSourceHeadRef,
  reviewSourceHeadRef,
} from "./review-source-ref";
import { ensurePinnedReviewWorktreeAtCommit } from "./review-worktree-target";
import { resolveReviewRoot, resolveReviewSource } from "./runtime";
import { compileReviewDocumentBundle } from "./server/doc-bundler";
import { reviewInfoEvent } from "./server/review-info";
import { traceMachineEnabled } from "./trace-machine-setup";

export interface RunReviewScaffoldInput {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  pullRequest?: string;
  env?: NodeJS.ProcessEnv;
  toolingRoot?: string;
  progress?: (message: string) => void;
  update?: boolean;
  reviewUuid?: string;
  newReview?: boolean;
  background?: boolean;
  onReviewBound?: (uuid: string) => void | Promise<void>;
}

// Scaffold's event carries pinned commits, managed checkouts, and normalized
// trace paths so the authoring agent never has to rediscover on-disk layout.
// A checkout is null only when its eager materialization degraded to a warning.
export interface ReviewScaffoldEvent extends ReviewInfoEvent {
  pins?: { baseCommit: string; sourceCommit: string };
  checkouts?: { head: string | null; base: string | null };
  traces: ReviewScaffoldTraces;
}

export interface ReviewScaffoldTraceSession {
  id: string;
  harness: ReviewAgentTraceSession["harness"];
  available: boolean;
  traces: string[];
  commits: ReviewAgentTraceSession["commits"];
}

export interface ReviewScaffoldTraces {
  sessions: ReviewScaffoldTraceSession[];
  corpusRoot: string | null;
  repository: string | null;
  materializedSessions: ReviewTracePullSessionResult[];
  unavailableSessions: string[];
  events: number;
  files: number;
  paths: string[];
}

/**
 * Creates one new UUID Review directory bound to the selected source. With
 * `update`, re-pins the existing review for the checkout from its bound
 * change instead — and falls through to creation when none exists (upsert).
 */
export async function runReviewScaffold(
  input: RunReviewScaffoldInput,
): Promise<ReviewScaffoldEvent> {
  if (input.update) {
    const existing = await findUpdateTarget(input.cwd, input.reviewUuid);
    if (existing) {
      await input.onReviewBound?.(existing.review.uuid);
      return repinReview(existing, input);
    }
  }
  return createReview(input);
}

async function createReview(
  input: RunReviewScaffoldInput,
): Promise<ReviewScaffoldEvent> {
  const source = await resolveReviewSource(input);
  if (!source.subject.headRef) {
    throw new Error("Review scaffold requires a resolved source head.");
  }
  const sourceHead = source.subject.headRef;
  if (isPositionalChangeIdentity(sourceHead)) {
    throw new Error(
      "The checkout has no branch, bookmark, or change id to bind the review to. Check one out or pass --head <ref>.",
    );
  }
  const sourceHeadCommit = await resolveRequiredRevision(
    source.reviewRoot,
    sourceHead,
    "source",
  );
  const sourceIdentity: ReviewSourceIdentity | null =
    source.subject.pullRequestNumber != null
      ? { kind: "git-branch", name: sourceHead }
      : await changeIdentityForRevision(source.reviewRoot, sourceHead);
  if (!sourceIdentity) {
    throw new Error(`Source identity ${sourceHead} does not resolve uniquely.`);
  }
  if (!input.newReview) {
    await rejectDuplicateActiveReviews(source.reviewRoot, sourceIdentity);
  }
  const baseCommit = await resolveForkPoint(
    source.reviewRoot,
    source.subject.baseRef,
    sourceHeadCommit,
  );
  const uuid = createReviewUuid();
  const sourceHeadRef = reviewSourceHeadRef(uuid);
  // The review pins the bound head commit. The working tree never
  // contributes: uncommitted edits stay out of the review.
  await pinReviewSourceHeadRef(
    source.reviewRoot,
    sourceHeadRef,
    sourceHeadCommit,
  );
  const sourceCommit = sourceHeadCommit;
  const setup = await materializeReviewSetup({
    reviewRoot: source.reviewRoot,
    uuid,
    headCommit: sourceCommit,
    baseCommit,
    progress: input.progress,
    background: input.background,
  });
  const invokingAgent = resolveAuthoringSessionRef(input.env ?? process.env);
  let sourceAgentSession: string | null = null;
  if (invokingAgent) {
    if (!setup.headRootPath) {
      throw new Error(
        "Review scaffold cannot create a source session without its managed head checkout.",
      );
    }
    const frozen = await createReviewSourceAgentSession({
      agent: invokingAgent,
      reviewUuid: uuid,
      rootPath: setup.headRootPath,
    });
    sourceAgentSession = authoringSessionKey(frozen);
  }
  let created: StoredReview;
  try {
    created = await createReviewDir({
      uuid,
      worktreePath: source.reviewRoot,
      baseRef: source.subject.baseRef,
      baseCommit,
      sourceCommit,
      sourceIdentity,
      pullRequestNumber: source.subject.pullRequestNumber ?? null,
      pullRequestUrl: source.subject.pullRequestUrl ?? null,
      title: source.subject.pullRequestTitle ?? "Progressive Review",
      sourceSession: sourceAgentSession ?? undefined,
    });
  } catch (error) {
    await removeReviewManagedCheckouts({
      rootPath: source.reviewRoot,
      reviewUuid: uuid,
    }).catch(() => undefined);
    await deleteReviewSourceHeadRef(source.reviewRoot, sourceHeadRef);
    throw error;
  }
  await input.onReviewBound?.(created.review.uuid);
  const traceSetup = await discoverAndPullScaffoldTraces({
    rootPath: source.reviewRoot,
    baseCommit,
    headCommit: sourceCommit,
    progress: input.progress,
  });
  setup.warnings.push(...traceSetup.warnings);
  const event: ReviewScaffoldEvent = {
    ...(await reviewInfoEvent([created])),
    pins: { baseCommit, sourceCommit },
    checkouts: {
      head: setup.headRootPath ?? null,
      base: setup.baseRootPath ?? null,
    },
    traces: traceSetup.traces,
  };
  return setup.warnings.length > 0
    ? { ...event, warnings: setup.warnings }
    : event;
}

// Re-pin from the review's binding, not from the checkout. A branch-bound
// review re-resolves its bookmark or branch tip; a PR-bound review re-fetches
// the PR refs first. The working tree is irrelevant, so mid-stack reviews
// update correctly from anywhere. All fallible resolution happens before the
// source head ref moves, so a failed update leaves the review untouched.
export async function repinReview(
  review: StoredReview,
  input: RunReviewScaffoldInput,
): Promise<ReviewScaffoldEvent> {
  const root = review.review.worktreePath;
  const uuid = review.review.uuid;
  const oldHeadCommit = review.review.sourceCommit;
  const oldBaseCommit = review.review.baseCommit;
  let sourceIdentity = review.review.sourceIdentity;
  let sourceBranch = sourceIdentity?.name;
  if (
    !sourceIdentity ||
    !sourceBranch ||
    isPositionalChangeIdentity(sourceBranch)
  ) {
    throw new Error(
      `Review ${uuid} has no bound change to update from. Run \`review rebind\` first.`,
    );
  }
  let defaultBaseRef = review.review.baseRef;
  if (review.review.pullRequestNumber != null) {
    const source = await resolveReviewSource({
      cwd: root,
      pullRequest:
        review.review.pullRequestUrl ?? String(review.review.pullRequestNumber),
      baseRef: input.baseRef,
    });
    if (!source.subject.headRef) {
      throw new Error("Review update requires a resolved source head.");
    }
    sourceBranch = source.subject.headRef;
    sourceIdentity = { kind: "git-branch", name: sourceBranch };
    defaultBaseRef = source.subject.baseRef;
  }
  const headCommit = await resolveRequiredRevision(
    root,
    sourceBranch,
    "source",
  );
  const baseRef = input.baseRef?.trim() || defaultBaseRef;
  const baseCommit = await resolveForkPoint(root, baseRef, headCommit);
  const sourceCommit = headCommit;
  const setup = await materializeReviewSetup({
    reviewRoot: root,
    uuid,
    headCommit: sourceCommit,
    baseCommit,
    progress: input.progress,
    background: input.background,
  });
  const invokingAgent = resolveAuthoringSessionRef(input.env ?? process.env);
  let sourceSession = DISABLED_REVIEW_SOURCE_SESSION;
  if (invokingAgent) {
    if (!setup.headRootPath) {
      throw new Error(
        "Review update cannot create a source session without its managed head checkout.",
      );
    }
    // The fork belongs to the same unit of work as the pin. A Review whose
    // Ask Agent cannot answer is not a usable Review, so a failure here fails
    // the update and leaves the stored pins untouched.
    const frozen = await createReviewSourceAgentSession({
      agent: invokingAgent,
      reviewUuid: uuid,
      rootPath: setup.headRootPath,
    });
    sourceSession = authoringSessionKey(frozen);
  }
  await pinReviewSourceHeadRef(root, reviewSourceHeadRef(uuid), headCommit);
  const updated = await updateReviewPins(review, {
    baseRef,
    baseCommit,
    sourceCommit,
    sourceIdentity,
    sourceSession,
  });
  await reportRangeStaleness({
    review: updated,
    oldHeadCommit,
    newHeadCommit: sourceCommit,
    oldBaseCommit,
    newBaseCommit: baseCommit,
    progress: input.progress,
  }).catch(() => undefined);
  if (updated !== review && updated.review.status === "awaiting-review") {
    setup.warnings.push(
      "Pins moved under a published revision. Publish again to present the new commits.",
    );
  }
  const traceSetup = await discoverAndPullScaffoldTraces({
    rootPath: root,
    baseCommit,
    headCommit: sourceCommit,
    progress: input.progress,
  });
  setup.warnings.push(...traceSetup.warnings);
  const event: ReviewScaffoldEvent = {
    ...(await reviewInfoEvent([updated])),
    pins: { baseCommit, sourceCommit },
    checkouts: {
      head: setup.headRootPath ?? null,
      base: setup.baseRootPath ?? null,
    },
    traces: traceSetup.traces,
  };
  return setup.warnings.length > 0
    ? { ...event, warnings: setup.warnings }
    : event;
}

function reportTraceSessionsProgress(
  sessions: ReviewAgentTraceSession[],
  progress?: (message: string) => void,
): void {
  if (!progress) return;
  if (sessions.length === 0) {
    progress("Sessions: none recorded for this change range");
    return;
  }
  progress("Sessions:");
  for (const s of sessions) {
    const shortId =
      s.sessionId.length > 8 ? `${s.sessionId.slice(0, 8)}…` : s.sessionId;
    const harness =
      s.harness === "claude-code"
        ? "Claude Code"
        : s.harness === "codex"
          ? "Codex"
          : s.harness === "pi"
            ? "Pi"
            : "unknown";
    const syncLabel = s.available ? "[S3/R2 synced]" : "[not synced]";
    progress(`  ${shortId} (${harness})  ${syncLabel}`);
  }
}

async function discoverAndPullScaffoldTraces(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
  progress?: (message: string) => void;
}): Promise<{ traces: ReviewScaffoldTraces; warnings: string[] }> {
  // Trace storage is opt-in. Without it there is nothing to discover, and
  // probing R2 on every scaffold would only produce noise.
  if (!(await traceMachineEnabled())) {
    return { traces: emptyScaffoldTraces([]), warnings: [] };
  }

  let resolvedSessions: ReviewAgentTraceSession[];
  try {
    resolvedSessions = await listReviewTraceSessions(input);
  } catch (error) {
    return traceSetupFailure(
      [],
      `Agent trace discovery failed: ${formatError(error)}`,
      input.progress,
    );
  }

  reportTraceSessionsProgress(resolvedSessions, input.progress);
  const sessions = resolvedSessions.map(scaffoldTraceSession);
  const availableSessions = resolvedSessions.filter(
    (session) => session.available,
  );
  const unavailableSessions = resolvedSessions
    .filter((session) => !session.available)
    .map((session) => session.sessionId);
  if (availableSessions.length === 0) {
    return {
      traces: emptyScaffoldTraces(sessions, unavailableSessions),
      warnings: [],
    };
  }

  try {
    const repo = await inferRepoFromGit(input.rootPath);
    const pulled = await pullReviewTraceCorpus({
      repo,
      sessions: availableSessions.map((session) => ({
        id: session.sessionId,
        traces: session.subagents,
      })),
    });
    const traces: ReviewScaffoldTraces = {
      sessions,
      corpusRoot: pulled.corpusRoot,
      repository: pulled.repository,
      materializedSessions: pulled.sessions,
      unavailableSessions: [
        ...new Set([...unavailableSessions, ...pulled.unavailableSessions]),
      ],
      events: pulled.events,
      files: pulled.files,
      paths: pulled.paths,
    };
    reportTracePathsProgress(traces, input.progress);
    return { traces, warnings: [] };
  } catch (error) {
    return traceSetupFailure(
      sessions,
      `Agent trace materialization failed: ${formatError(error)}`,
      input.progress,
    );
  }
}

function scaffoldTraceSession(
  session: ReviewAgentTraceSession,
): ReviewScaffoldTraceSession {
  return {
    id: session.sessionId,
    harness: session.harness,
    available: session.available,
    traces: ["main", ...(session.subagents ?? [])],
    commits: session.commits,
  };
}

function emptyScaffoldTraces(
  sessions: ReviewScaffoldTraceSession[],
  unavailableSessions: string[] = [],
): ReviewScaffoldTraces {
  return {
    sessions,
    corpusRoot: null,
    repository: null,
    materializedSessions: [],
    unavailableSessions,
    events: 0,
    files: 0,
    paths: [],
  };
}

function traceSetupFailure(
  sessions: ReviewScaffoldTraceSession[],
  warning: string,
  progress?: (message: string) => void,
): { traces: ReviewScaffoldTraces; warnings: string[] } {
  progress?.(`Warning: ${warning}`);
  return {
    traces: emptyScaffoldTraces(
      sessions,
      sessions.map((session) => session.id),
    ),
    warnings: [warning],
  };
}

function reportTracePathsProgress(
  traces: ReviewScaffoldTraces,
  progress?: (message: string) => void,
): void {
  if (!progress) return;
  if (traces.paths.length === 0) {
    progress("Trace paths: none materialized");
    return;
  }
  progress("Trace paths:");
  for (const tracePath of traces.paths) {
    progress(`  ${tracePath}`);
  }
}

async function rejectDuplicateActiveReviews(
  reviewRoot: string,
  sourceIdentity: ReviewSourceIdentity,
): Promise<void> {
  const listed = await listReviews({ worktreePath: reviewRoot });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  const matches = listed.reviews.filter(
    ({ review }) =>
      review.status !== "accepted" &&
      review.status !== "rejected" &&
      review.sourceIdentity?.kind === sourceIdentity.kind &&
      review.sourceIdentity.name === sourceIdentity.name,
  );
  if (matches.length === 0) return;
  const uuids = matches.map(({ review }) => review.uuid).join(", ");
  throw new Error(
    `Active Reviews already exist for ${sourceIdentity.kind} ${sourceIdentity.name}: ${uuids}. ` +
      "Use --update, select one with --review <uuid>, or pass --new to create another Review.",
  );
}

// The `--update` scope: active reviews whose bound branch shares a line of
// work with the checkout — the checkout is at the bound tip, ahead of it, or
// behind it (the branch gained commits elsewhere). This is wider than the
// publish/info scope on purpose: a moved branch must still find its review
// rather than upsert a duplicate. No match is not an error — the caller
// falls through to creation.
async function findUpdateTarget(
  cwd: string,
  reviewUuid: string | undefined,
): Promise<StoredReview | null> {
  const reviewRoot = await resolveReviewRoot(cwd);
  const listed = await listReviews({ worktreePath: reviewRoot });
  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => error.message).join("\n")}`,
    );
  }
  const active = listed.reviews.filter(
    (review) =>
      review.review.status !== "accepted" &&
      review.review.status !== "rejected",
  );
  if (reviewUuid) {
    const review = active.find((entry) => entry.review.uuid === reviewUuid);
    if (!review) throw new Error(`Active review not found: ${reviewUuid}`);
    return review;
  }
  const checkout = await currentHead(reviewRoot).catch(() => null);
  if (!checkout) return null;
  const scoped: StoredReview[] = [];
  for (const review of active) {
    const binding = review.review.sourceIdentity?.name;
    if (!binding || isPositionalChangeIdentity(binding)) continue;
    const tip = await resolveRevision(reviewRoot, binding).catch(() => null);
    if (!tip) continue;
    if (tip.commit === checkout.commit) {
      scoped.push(review);
      continue;
    }
    const ancestor = await mergeBase({
      rootPath: reviewRoot,
      baseRef: tip.commit,
      headRef: checkout.commit,
    }).catch(() => null);
    if (
      ancestor &&
      (ancestor.commit === tip.commit || ancestor.commit === checkout.commit)
    ) {
      scoped.push(review);
    }
  }
  if (scoped.length > 1) {
    throw new Error("Multiple active reviews require --review <uuid>.");
  }
  return scoped[0] ?? null;
}

// Eagerly materialize one prepared worktree per pin. Failures degrade to
// warnings. The lazy source paths retry.
async function materializeReviewSetup(input: {
  reviewRoot: string;
  uuid: string;
  headCommit: string;
  baseCommit?: string;
  progress?: (message: string) => void;
  background?: boolean;
}): Promise<{
  warnings: string[];
  headRootPath?: string;
  baseRootPath?: string;
}> {
  const warnings: string[] = [];
  const prepareCommands = await devfastPrepareCommands(input.reviewRoot).catch(
    () => [] as string[],
  );
  if (prepareCommands.length === 0) {
    warnings.push(
      "devfast.prepare is not configured. Configure it (git config devfast.prepare '<command>') and run `review scaffold --update` to prepare pinned worktrees.",
    );
  }
  const pins = [
    { role: "head" as const, commit: input.headCommit },
    ...(input.baseCommit && input.baseCommit !== input.headCommit
      ? [{ role: "base" as const, commit: input.baseCommit }]
      : []),
  ];
  for (const pin of pins) {
    input.progress?.(
      `Review scaffold prepares the pinned-${pin.role} worktree.`,
    );
  }
  const results = await Promise.all(
    pins.map(async (pin) => {
      try {
        const checkoutPath = await ensurePinnedReviewWorktreeAtCommit({
          repoRoot: input.reviewRoot,
          commit: pin.commit,
          reviewUuid: input.uuid,
          role: pin.role,
          warning: (message) => warnings.push(message),
          background: input.background,
        });
        return { role: pin.role, checkoutPath };
      } catch (error) {
        warnings.push(
          `Pinned-${pin.role} worktree creation failed. Review will retry it: ${formatError(error)}`,
        );
        return { role: pin.role, checkoutPath: undefined };
      }
    }),
  );
  const headRootPath = results.find((r) => r.role === "head")?.checkoutPath;
  const baseRootPath =
    !input.baseCommit || input.baseCommit === input.headCommit
      ? headRootPath
      : results.find((r) => r.role === "base")?.checkoutPath;
  return { warnings: [...new Set(warnings)], headRootPath, baseRootPath };
}

async function reportRangeStaleness(input: {
  review: StoredReview;
  oldHeadCommit: string | null;
  newHeadCommit: string;
  oldBaseCommit: string;
  newBaseCommit: string;
  progress?: (message: string) => void;
}): Promise<void> {
  if (!input.progress) return;
  const compiled = await compileReviewDocumentBundle({
    reviewPath: path.join(input.review.dir, "review.mdx"),
    reviewDocumentsDir: path.join(input.review.dir, ".review-documents"),
    reviewRootPath: input.review.dir,
    routePath: "/",
  });
  if (!compiled.bundle) return;
  const evaluated = await evaluateReviewDocumentBundleForPublish({
    bundleCode: compiled.bundle.code,
    reviewDir: input.review.dir,
    validateRanges: false,
  });
  if (evaluated.errors.length > 0) return;

  const changedBySide = new Map<"head" | "base", Set<string>>();
  const changes = [
    {
      side: "head" as const,
      oldCommit: input.oldHeadCommit,
      newCommit: input.newHeadCommit,
    },
    {
      side: "base" as const,
      oldCommit: input.oldBaseCommit,
      newCommit: input.newBaseCommit,
    },
  ];
  for (const change of changes) {
    if (!change.oldCommit || change.oldCommit === change.newCommit) continue;
    const diff = await diffNameStatusTrees({
      rootPath: input.review.review.worktreePath,
      baseRef: change.oldCommit,
      headRef: change.newCommit,
    });
    changedBySide.set(
      change.side,
      new Set([...diff.changedFiles, ...diff.deletedFiles]),
    );
  }

  for (const peek of evaluated.rangePeeks) {
    const side = peek.graph ?? "head";
    if (!changedBySide.get(side)?.has(peek.file)) continue;
    input.progress(
      `anchor \`${peek.anchorId ?? "unknown"}\`: \`${peek.file}\` changed between pins — re-read and adjust the range.`,
    );
  }
}

// The pinned base is the merge base (fork point) of base and head, like a
// GitHub PR diff. A null merge base means the histories share no common
// ancestor (or the VCS cannot answer, for example a shallow clone). That is
// not a reviewable pair, so scaffold fails instead of guessing a base.
async function resolveForkPoint(
  rootPath: string,
  baseRef: string,
  headCommit: string,
): Promise<string> {
  const resolvedBaseCommit = await resolveRequiredRevision(
    rootPath,
    baseRef,
    "base",
  );
  const forkPoint = await mergeBase({
    rootPath,
    baseRef: resolvedBaseCommit,
    headRef: headCommit,
  });
  if (!forkPoint) {
    throw new Error(
      `No merge base exists between review base ${baseRef} and head ${headCommit}. The histories share no common ancestor.`,
    );
  }
  return forkPoint.commit;
}

async function resolveRequiredRevision(
  rootPath: string,
  ref: string,
  label: string,
): Promise<string> {
  const resolved = await resolveRevision(rootPath, ref);
  if (!resolved) {
    throw new Error(`Review ${label} revision does not exist: ${ref}`);
  }
  return resolved.commit;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
