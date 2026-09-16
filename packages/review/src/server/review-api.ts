import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  type LocalVcsCommitSummary,
  currentHead,
  detectLocalVcs,
  listCommitRange,
  resolveRevision,
} from "@dev.fast/local-vcs";
import {
  type JsonObject,
  type JsonValue,
  type ReviewRecord,
  type ReviewSessionWire,
  type ReviewStackResponse,
  isJsonObject,
  jsonString,
  parseReviewFileContentRequest,
} from "@dev.fast/review-protocol";
import {
  TraceConfigurationError,
  type TraceStorage,
  TraceStorageDeniedError,
  type TraceStorageKind,
  isS3MockMode,
  isTraceStorageConfigured,
  listReviewTraceSessions,
  loadReviewAgentTrace,
  resolveTraceStorage,
  selectTraceStorage,
} from "@dev.fast/trace-core";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { AgentSelectionSchema, selectionMarkdown } from "../agent-selection";
import { mergeErrorTelemetryProperties } from "../error-telemetry";
import { resolveReviewCommitScope } from "../review-commits";
import type { ReviewDiffFilesResult } from "../review-diff-files";
import {
  resolveReviewDiffFiles,
  resolveReviewFileContent,
} from "../review-diff-files";
import {
  normalizeReviewRoutePath,
  resolveReviewDocumentFilePath,
} from "../review-document-routes";
import { listReviews } from "../review-home";
import { ReviewBusyError, reviewBusyResponse } from "../review-mutation-lock";
import { resolveReviewStackLayers } from "../review-stack";
import {
  type ReviewSourceTarget,
  readReviewStoreRecord,
  resolveReviewRepoRootFromStore,
  resolveReviewSessionBaseCommit,
  resolveReviewSourceTarget,
} from "../review-worktree-target";
import { materializeSoftwareMapAtRef } from "../software-map-artifact";
import { resolveSoftwareMapDiffCounts } from "../software-map-diff-counts";
import { ReviewTelemetry } from "../telemetry";
import type { ReviewTabTelemetryEvent } from "../telemetry";
import {
  REVIEW_APP_SESSION_ID_HEADER,
  sanitizeUiTelemetryEvent,
} from "../ui-telemetry-events";
import { BugReportUpstreamError, submitReviewBugReport } from "./bug-report";
import {
  type ReviewHonoEnv,
  jsonResponse,
  readBoundedRequestJson,
} from "./hono-http";
import {
  parseReviewBugReportInput,
  parseReviewDiffFilesInput,
  parseReviewTabTelemetryInput,
  parseSoftwareMapCodeElements,
  parseSoftwareMapCoverageClaims,
  requestJsonErrorStatus,
} from "./review-api-parsers";
import {
  type ReviewSessionMode,
  reviewSessionModeIsReadOnly,
  reviewSessionModeRecord,
} from "./review-session-mode";

const defaultTelemetry = new ReviewTelemetry();

const MAX_CLIENT_ERROR_SESSIONS = 100;

const MAX_CLIENT_ERRORS_PER_SESSION = 20;

const clientErrorsBySession = new Map<string, string[]>();

export function recordClientError(
  event: ReturnType<typeof sanitizeUiTelemetryEvent>,
): void {
  if (event?.event !== "review_client_error") return;
  const sessionId = jsonString(event.properties.app_session_id);
  const errorName = jsonString(event.properties.error_name);

  if (sessionId === undefined || errorName === undefined) return;
  const names = clientErrorsBySession.get(sessionId) ?? [];
  names.push(errorName);

  if (names.length > MAX_CLIENT_ERRORS_PER_SESSION) names.shift();
  clientErrorsBySession.delete(sessionId);
  clientErrorsBySession.set(sessionId, names);

  while (clientErrorsBySession.size > MAX_CLIENT_ERROR_SESSIONS) {
    const oldest = clientErrorsBySession.keys().next().value;

    if (oldest === undefined) break;
    clientErrorsBySession.delete(oldest);
  }
}

export function clientErrorsForSession(sessionId: string): string[] {
  const names = clientErrorsBySession.get(sessionId) ?? [];

  if (names.length > 0) {
    clientErrorsBySession.delete(sessionId);
    clientErrorsBySession.set(sessionId, names);
  }

  return [...names];
}

interface SoftwareMapResolvedDataResponse {
  countsByElementPath: Awaited<
    ReturnType<typeof resolveSoftwareMapDiffCounts>
  >["countsByElementPath"];
  unmappedByElementPath: Awaited<
    ReturnType<typeof resolveSoftwareMapDiffCounts>
  >["unmappedByElementPath"];
}

export interface ReviewTelemetryCapture {
  captureTabViewed(event: ReviewTabTelemetryEvent): Promise<void>;
  captureUiEvent?(
    event: string,
    properties: Record<string, string | number | boolean>,
  ): Promise<void>;
}

export async function captureSanitizedUiTelemetry(
  telemetry: ReviewTelemetryCapture,
  request: Request,
  name: JsonValue,
  properties: JsonValue,
  onSanitized?: (
    event: NonNullable<ReturnType<typeof sanitizeUiTelemetryEvent>>,
  ) => void,
  /**
   * The raw error envelope, which arrives beside `properties` and never inside
   * it. This function is where the raw form dies: what continues is the class
   * name, the message with paths and secrets replaced by markers, a digest of
   * the original message, and bundle-relative frames. The allowlist re-checks
   * all of it. Never merge this into `properties`.
   */
  rawError?: JsonValue,
): Promise<void> {
  const appSessionId =
    request.headers.get(REVIEW_APP_SESSION_ID_HEADER) ?? undefined;

  const rawProperties: JsonObject = isJsonObject(properties) ? properties : {};

  // The error fields come from the raw envelope and nowhere else; this
  // helper drops any a client tried to assert. It matters because the
  // allowlist cannot tell a cleaned message from a raw one.
  const mergedProperties = mergeErrorTelemetryProperties(
    rawProperties,
    rawError,
  );

  if (appSessionId) mergedProperties.app_session_id = appSessionId;

  const sanitized = sanitizeUiTelemetryEvent({
    name,
    properties: mergedProperties,
  });

  if (!sanitized) return;
  onSanitized?.(sanitized);

  try {
    await telemetry.captureUiEvent?.(sanitized.event, sanitized.properties);
  } catch (error) {
    console.error(error);
  }
}

export interface ReviewApiOptions {
  mode: ReviewSessionMode;
  sourceUnavailable?: string;
  reviewPath: string;
  reviewDocumentsDir: string;
  rootPath: string;
  reviewRootPath?: string;
  toolingRoot: string;
  stateReviewPath?: string;
  telemetry?: ReviewTelemetryCapture;
  onReviewDismiss?: () => void | Promise<void>;
  onReviewDataChange?: () => void;
  /** Resolves the pinned head/base worktrees for a live session. Tests
   * inject a stub; production uses `resolveReviewSourceTarget`. */
  resolveSourceTarget?: (input: {
    reviewRootPath: string;
  }) => Promise<ReviewSourceTarget>;
  reviewToken: string;
  session: ReviewSessionWire;
}

type ReviewApiHandler = (
  context: Context<ReviewHonoEnv>,
) => Promise<Response> | Response;

export interface ReviewApi {
  app: Hono<ReviewHonoEnv>;
}

export function createReviewApi(options: ReviewApiOptions): ReviewApi {
  const readOnlyReview = reviewSessionModeRecord(options.mode);

  const reviewRootPath =
    options.reviewRootPath ??
    options.session.storageDir ??
    path.dirname(options.stateReviewPath ?? options.reviewPath);

  const app = new Hono<ReviewHonoEnv>();

  const {
    reviewPath,
    reviewDocumentsDir,
    rootPath,
    telemetry = defaultTelemetry,
    onReviewDismiss,
    stateReviewPath,
    session,
  } = options;

  const diffCorpora = new Map<string, Promise<ReviewDiffFilesResult>>();

  // Every handler answers through the same catch, so a thrown parse or state
  // error becomes the route's JSON error response instead of a 500.
  const route =
    (access: "read" | "write", handler: ReviewApiHandler): ReviewApiHandler =>
    async (context) => {
      try {
        if (access === "write" && reviewSessionModeIsReadOnly(options.mode)) {
          return reviewApiJsonResponse(409, {
            ok: false,
            error: "This historical version is read-only.",
            code: "historical_revision",
          });
        }

        return await handler(context);
      } catch (err) {
        if (err instanceof ReviewBusyError)
          return reviewApiJsonResponse(409, reviewBusyResponse(err));

        return reviewApiJsonResponse(requestJsonErrorStatus(err), {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

  app.post(
    "/copy-context",
    route("read", async (context) => {
      const input = AgentSelectionSchema.parse(await readJson(context.req.raw));
      const target = input.target;

      const pinnedRoot = (root: string | undefined, file: string) => {
        if (!root) throw new Error("Pinned worktree unavailable");

        if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
          throw new Error("Invalid diff path");

        return path.resolve(root);
      };

      let excerpt = "";

      if (target.kind === "code" && !input.selectedDiff) {
        pinnedRoot(
          target.side === "base" ? session.baseRootPath : session.headRootPath,
          target.path,
        );
        const vcs = await detectLocalVcs(rootPath);

        const commit =
          target.side === "base" ? session.baseRef : session.headRef;

        if (!vcs || !commit) throw new Error("Pinned source unavailable");
        const source = await vcs.readFileAtRef(commit, target.path);

        if (source === null) throw new Error("Pinned source unavailable");
        excerpt =
          `## ${target.side}: ${target.path}:${target.startLine}-${target.endLine} (${commit})\n` +
          source
            .split("\n")
            .slice(target.startLine - 1, target.endLine)
            .map((line) => `    ${line}`)
            .join("\n");
      }

      const diff = input.selectedDiff;

      const paths = diff
        ? {
            base: pinnedRoot(session.baseRootPath, diff.oldPath),
            head: pinnedRoot(session.headRootPath, diff.newPath),
          }
        : undefined;

      const text = selectionMarkdown(input, excerpt, paths);
      const authoringFile = path.resolve(stateReviewPath ?? reviewPath);

      const clipboardText =
        target.kind === "text"
          ? `Selected text from Review document:\n${authoringFile}\n\n${text}`
          : target.kind === "code"
            ? `Selected code from Review:\nReview document: ${authoringFile}\nFile: ${diff?.newPath || diff?.oldPath || target.path}\n\n${text}`
            : `Selected ${input.diagramContext?.kind === "node" ? "diagram node" : (input.diagramContext?.kind ?? "diagram element")} from Review:\nReview document: ${authoringFile}\n\n${text}`;

      return context.json({ text: `${clipboardText}\n\n` });
    }),
  );

  app.post("/telemetry/tab", route("read", telemetryTab));
  app.post("/telemetry/event", route("read", telemetryEvent));
  app.post("/telemetry/bug-report", route("read", bugReport));
  app.get("/session", route("read", sessionInfo));
  app.post("/dismiss", route("write", reviewDismiss));
  app.post(
    "/software-map/resolved-data",
    route("read", softwareMapResolvedData),
  );
  app.post(
    "/software-map/artifacts/refresh",
    route("write", softwareMapArtifactsRefresh),
  );
  app.get("/document-meta", route("read", documentMeta));
  app.get("/stack", route("read", reviewStack));
  app.post("/diff-files", route("read", diffFiles));
  app.get("/file-content", route("read", fileContent));
  app.get("/agent-traces", route("read", agentTraces));
  app.get("/agent-traces/:sessionId", route("read", agentTraceDetail));
  app.notFound(() =>
    reviewApiJsonResponse(404, { ok: false, error: "not found" }),
  );

  type TraceStorageOverride =
    | { kind: "none" }
    | { kind: "invalid" }
    | { kind: "override"; storage: TraceStorageKind };

  /** The `?storage=` read override; invalid names never fall back silently. */
  function traceStorageOverride(
    context: Context<ReviewHonoEnv>,
  ): TraceStorageOverride {
    const value = new URL(context.req.url).searchParams.get("storage");

    if (value === null) return { kind: "none" };

    if (value === "s3" || value === "hosted") {
      return { kind: "override", storage: value };
    }

    return { kind: "invalid" };
  }

  type TraceStorageResolution =
    | { storage: TraceStorage | null | undefined; error: null }
    | { storage: null; error: string };

  /**
   * The store a trace request reads from: the override when one is named,
   * otherwise the machine's selection (undefined lets shared code resolve
   * it). A refusal, a missing login for a requested source, or a malformed
   * config is returned as a message instead of thrown.
   */
  async function resolveTraceStorageFor(
    override: TraceStorageOverride,
    cwd: string,
  ): Promise<TraceStorageResolution> {
    const selection = selectTraceStorage();

    if (selection.error) return { storage: null, error: selection.error };

    try {
      if (override.kind !== "override") {
        const storage = await resolveTraceStorage({ cwd });

        return { storage, error: null };
      }

      const storage = await resolveTraceStorage({
        cwd,
        override: override.storage,
      });

      if (!storage && override.storage === "hosted") {
        return {
          storage: null,
          error:
            "The hosted trace store has no login on this machine. Run `review login` and open the review again.",
        };
      }

      return { storage, error: null };
    } catch (error) {
      if (
        error instanceof TraceStorageDeniedError ||
        error instanceof TraceConfigurationError
      ) {
        return { storage: null, error: error.message };
      }

      throw error;
    }
  }

  const invalidStorageResponse = () =>
    reviewApiJsonResponse(400, {
      ok: false,
      error: "storage must be s3 or hosted.",
    });

  async function agentTraces(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const override = traceStorageOverride(context);

    if (override.kind === "invalid") return invalidStorageResponse();
    const review = readOnlyReview ?? readReviewStoreRecord(reviewRootPath);
    const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath, review);
    const headCommit = review.sourceCommit ?? review.baseCommit;
    const selection = selectTraceStorage();
    const sources: TraceStorageKind[] = [];

    if (selection.s3?.credentials || isS3MockMode()) {
      sources.push("s3");
    }

    if (selection.hosted) sources.push("hosted");

    const storage =
      override.kind === "override" ? override.storage : selection.mode;

    const answerNothing = (storageError: string) =>
      reviewApiJsonResponse(200, {
        ok: true,
        configured: isTraceStorageConfigured(),
        storage,
        sources,
        storageError,
        sessions: [],
      });

    const resolved = await resolveTraceStorageFor(override, repoRootPath);

    if (resolved.error !== null) return answerNothing(resolved.error);
    let sessions: Awaited<ReturnType<typeof listReviewTraceSessions>>;

    try {
      sessions = await listReviewTraceSessions({
        rootPath: repoRootPath,
        baseCommit: review.baseCommit,
        headCommit,
        storage: resolved.storage,
      });
    } catch (error) {
      if (!(error instanceof TraceStorageDeniedError)) throw error;

      return answerNothing(error.message);
    }

    return reviewApiJsonResponse(200, {
      ok: true,
      configured: isTraceStorageConfigured(),
      storage,
      sources,
      sessions,
    });
  }

  async function agentTraceDetail(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const sessionId = context.req.param("sessionId");

    if (!sessionId) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: "Session is required.",
      });
    }

    const override = traceStorageOverride(context);

    if (override.kind === "invalid") return invalidStorageResponse();

    const trace =
      new URL(context.req.url).searchParams.get("trace") ?? undefined;

    const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath);
    const resolved = await resolveTraceStorageFor(override, repoRootPath);

    if (resolved.error !== null) {
      return reviewApiJsonResponse(404, { ok: false, error: resolved.error });
    }

    let loaded: Awaited<ReturnType<typeof loadReviewAgentTrace>>;

    try {
      loaded = await loadReviewAgentTrace({
        sessionId,
        trace,
        cwd: repoRootPath,
        storage: resolved.storage,
      });
    } catch (error) {
      if (!(error instanceof TraceStorageDeniedError)) throw error;

      return reviewApiJsonResponse(404, { ok: false, error: error.message });
    }

    if (!loaded) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: `Trace not found for session ${sessionId}${trace ? ` (subagent ${trace})` : ""}.`,
      });
    }

    const {
      parserVersion,
      descriptor,
      trace: parsedTrace,
      subagents,
      traceName,
    } = loaded;

    return reviewApiJsonResponse(200, {
      ok: true,
      parserVersion,
      session: descriptor,
      trace: traceName,
      cacheStatus: loaded.cacheStatus,
      subagents,
      title: parsedTrace.title,
      startedAt: parsedTrace.startedAt,
      endedAt: parsedTrace.endedAt,
      activeMs: parsedTrace.activeMs,
      userTurns: parsedTrace.userTurns,
      toolCalls: parsedTrace.toolCalls,
      events: parsedTrace.events,
    });
  }

  async function telemetryTab(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const event = parseReviewTabTelemetryInput(
      await readBoundedRequestJson(
        context.req.raw,
        undefined,
        {},
        {
          allowTextPlain: true,
        },
      ),
    );

    await telemetry.captureTabViewed(event);

    return reviewApiJsonResponse(200, { ok: true });
  }

  async function telemetryEvent(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    try {
      const body = await readJson(context.req.raw);
      const payload: JsonObject = isJsonObject(body) ? body : {};
      await captureSanitizedUiTelemetry(
        telemetry,
        context.req.raw,
        payload.name,
        payload.properties,
        recordClientError,
        payload.error,
      );
    } catch (error) {
      console.error(error);
    }

    return reviewApiJsonResponse(200, { ok: true });
  }

  async function bugReport(context: Context<ReviewHonoEnv>): Promise<Response> {
    try {
      const report = parseReviewBugReportInput(
        await readBoundedRequestJson(context.req.raw, 6 * 1024 * 1024, {}),
      );

      const reviewDocumentPath = resolveReviewDocumentPath(
        new URL(context.req.url),
        {
          reviewPath,
          reviewDocumentsDir,
        },
      );

      if (!reviewDocumentPath) {
        return reviewApiJsonResponse(404, {
          ok: false,
          error: "Review document not found.",
        });
      }

      const result = await submitReviewBugReport({
        report,
        reviewDocumentPath,
        reviewRootPath,
        clientErrorNames: clientErrorsForSession(report.app_session_id),
      });

      return reviewApiJsonResponse(200, result);
    } catch (error) {
      // An upstream rejection carries its own status; route() would flatten
      // every one of them to 400.
      const status =
        error instanceof BugReportUpstreamError
          ? error.status
          : requestJsonErrorStatus(error);

      return reviewApiJsonResponse(status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function sessionInfo(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const url = new URL(context.req.url);

    const documentPath = resolveReviewDocumentPath(url, {
      reviewPath,
      reviewDocumentsDir,
    });

    if (!documentPath) {
      throw new Error("Review document not found.");
    }

    const resolvedBaseRef = await resolveReviewSessionBaseCommit({
      reviewRootPath,
    });

    return reviewApiJsonResponse(200, {
      ok: true,
      session: stateReviewPath
        ? { resolvedBaseRef, reviewStatus: readReviewStatus(stateReviewPath) }
        : { resolvedBaseRef },
    });
  }

  function reviewDismiss(context: Context<ReviewHonoEnv>): Response {
    // Respond first so the canvas receives its acknowledgment before the
    // desktop updates the durable review status.
    context.env.outgoing.once("close", () => {
      void Promise.resolve(onReviewDismiss?.())
        .then(() =>
          captureSanitizedUiTelemetry(
            telemetry,
            context.req.raw,
            "review_dismissed",
            {
              via: "review_topbar",
            },
            recordClientError,
          ),
        )
        .catch((error) => console.error(error));
    });

    return reviewApiJsonResponse(200, { ok: true });
  }

  async function softwareMapResolvedData(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const body = await readJsonObject(context.req.raw);
    const codeElements = parseSoftwareMapCodeElements(body.codeElements);
    const coverageClaims = parseSoftwareMapCoverageClaims(body.coverageClaims);
    const sourceTarget = await requestSourceTarget();

    const result = await buildSoftwareMapResolvedData({
      sourceTarget,
      codeElements,
      coverageClaims,
    });

    return reviewApiJsonResponse(200, { ok: true, ...result });
  }

  async function softwareMapArtifactsRefresh(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const url = new URL(context.req.url);

    const reviewDocumentPath = resolveReviewDocumentPath(url, {
      reviewPath,
      reviewDocumentsDir,
    });

    if (!reviewDocumentPath) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: "Review document not found.",
      });
    }

    // Notes are the durable map state. Refreshing the canvas only
    // re-materializes note-backed artifacts; map edits are published by
    // `review map check` after validation succeeds.
    const result = await rematerializeReviewSoftwareMapArtifacts({
      reviewRootPath,
    });

    return reviewApiJsonResponse(200, { ok: true, refresh: result });
  }

  function documentMeta(context: Context<ReviewHonoEnv>): Response {
    const url = new URL(context.req.url);

    const documentPath = resolveReviewDocumentPath(url, {
      reviewPath,
      reviewDocumentsDir,
    });

    if (!documentPath) {
      throw new Error("Review document not found.");
    }

    const stats = statSync(documentPath);

    return reviewApiJsonResponse(200, {
      ok: true,
      updatedAtMs: stats.mtimeMs,
      pullRequestNumber: session?.pullRequestNumber ?? null,
      pullRequestUrl: session?.pullRequestUrl ?? null,
    });
  }

  async function reviewStack(): Promise<Response> {
    const current = readOnlyReview ?? readReviewStoreRecord(reviewRootPath);

    if (!current.pullRequestNumber) {
      return reviewApiJsonResponse(200, { layers: [] });
    }

    const listed = await listReviews();
    const reviews = listed.reviews.map((stored) => stored.review);
    reviews.sort(
      (left, right) =>
        (right.lastPublishedAt ?? "").localeCompare(
          left.lastPublishedAt ?? "",
        ) || left.uuid.localeCompare(right.uuid),
    );

    return reviewApiJsonResponse(200, {
      layers: await resolveReviewStackLayers(current, reviews),
    });
  }

  async function diffFiles(context: Context<ReviewHonoEnv>): Promise<Response> {
    const url = new URL(context.req.url);
    const body = parseReviewDiffFilesInput(await readJson(context.req.raw));
    const diffTarget = await resolveScopedDiffTarget(url, body.commit);
    const corpus = await diffCorpus(diffTarget);
    const requestedPaths = new Set(body.paths ?? []);

    const files = corpus.files
      .filter(
        (file) =>
          requestedPaths.size === 0 ||
          requestedPaths.has(file.path) ||
          (file.previousPath !== undefined &&
            requestedPaths.has(file.previousPath)),
      )
      .map(({ patch, ...file }) =>
        body.includePatch ? { ...file, patch } : file,
      );

    const result = { ...corpus, files };

    return reviewApiJsonResponse(200, { ok: true, ...result });
  }

  async function fileContent(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const url = new URL(context.req.url);
    const contentQuery: JsonObject = {};

    for (const key of ["path", "side", "commit"]) {
      const value = url.searchParams.get(key);

      if (value !== null) contentQuery[key] = value;
    }

    const contentRequest = parseReviewFileContentRequest(contentQuery);

    const diffTarget = await resolveScopedDiffTarget(
      url,
      contentRequest.commit,
    );

    const comparison = await diffCorpus(diffTarget);

    const result = await resolveReviewFileContent({
      ...diffTarget,
      ...contentRequest,
      comparison,
    });

    return reviewApiJsonResponse(200, { ok: true, ...result });
  }

  function diffCorpus(diffTarget: {
    rootPath: string;
    baseRef?: string;
    headRef?: string;
  }): Promise<ReviewDiffFilesResult> {
    const key = JSON.stringify([
      diffTarget.rootPath,
      diffTarget.baseRef ?? "",
      diffTarget.headRef ?? "",
    ]);

    const cached = diffCorpora.get(key);

    if (cached) return cached;
    let pending: Promise<ReviewDiffFilesResult>;
    pending = resolveReviewDiffFiles({
      ...diffTarget,
      includePatch: true,
    }).catch((error) => {
      if (diffCorpora.get(key) === pending) diffCorpora.delete(key);
      throw error;
    });
    diffCorpora.set(key, pending);

    if (diffCorpora.size > 32) {
      const oldest = diffCorpora.keys().next().value;

      if (oldest !== undefined) diffCorpora.delete(oldest);
    }

    return pending;
  }

  async function reviewCommits(
    repoRootPath: string,
    baseCommit: string,
    headCommit: string,
  ): Promise<LocalVcsCommitSummary[]> {
    if (baseCommit === headCommit) return [];

    return listCommitRange({
      rootPath: repoRootPath,
      baseRef: baseCommit,
      headRef: headCommit,
    });
  }

  async function resolveScopedDiffTarget(url: URL, commit?: string) {
    if (options.sourceUnavailable) throw new Error(options.sourceUnavailable);

    const target = resolveRequestDiffTarget(url, {
      reviewPath,
      reviewDocumentsDir,
      rootPath: reviewRootPath,
      session,
      record: readOnlyReview,
    });

    if (!commit) return target;
    const review = readOnlyReview ?? readReviewStoreRecord(reviewRootPath);
    const headCommit = review.sourceCommit ?? review.baseCommit;

    const scope = resolveReviewCommitScope(
      await reviewCommits(target.rootPath, review.baseCommit, headCommit),
      commit,
    );

    return {
      rootPath: target.rootPath,
      ...scope,
    };
  }

  const resolveSourceTarget =
    options.resolveSourceTarget ?? resolveReviewSourceTarget;

  // Resolving the pinned checkouts costs several git subprocesses. A session
  // serves one revision, so one resolution serves every request until a
  // checkout root disappears from disk; the desktop host applies the same
  // existence test to its own checkout-root cache.
  let liveSourceTarget: Promise<ReviewSourceTarget> | null = null;

  const sourceTargetRootsExist = (target: ReviewSourceTarget): boolean =>
    existsSync(target.sourceRootPath) &&
    (!target.preparedBase || existsSync(target.preparedBase.sourceRootPath));

  async function requestSourceTarget(): Promise<ReviewSourceTarget> {
    if (!readOnlyReview) {
      const cached = liveSourceTarget;

      if (cached) {
        const target = await cached.catch(() => null);

        if (target && sourceTargetRootsExist(target)) return target;

        // Another request already replaced a failed or stale entry.
        if (liveSourceTarget !== cached) return requestSourceTarget();
      }

      const pending = resolveSourceTarget({ reviewRootPath });
      liveSourceTarget = pending;

      return pending;
    }

    if (options.sourceUnavailable) throw new Error(options.sourceUnavailable);

    if (!session.headRootPath || !session.baseRootPath)
      throw new Error("The pinned source worktrees are unavailable.");

    return {
      repoRoot: rootPath,
      sourceRootPath: session.headRootPath,
      diffRootPath: rootPath,
      headRef: readOnlyReview.sourceCommit ?? undefined,
      baseRef: readOnlyReview.baseCommit,
      preparedBase: {
        ref: readOnlyReview.baseCommit,
        sourceRootPath: session.baseRootPath,
      },
    };
  }

  return { app };
}

function readReviewStatus(stateReviewPath: string): string {
  return readReviewStoreRecord(path.dirname(stateReviewPath)).status;
}

function readJson(request: Request): Promise<JsonValue> {
  return readBoundedRequestJson(request, undefined, {});
}

async function readJsonObject(request: Request): Promise<JsonObject> {
  const body = await readJson(request);

  if (!isJsonObject(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  return body;
}

interface ReviewApiStatusBody {
  ok: boolean;
}

type ReviewApiResponseBody = ReviewApiStatusBody | ReviewStackResponse;

function reviewApiJsonResponse<T extends ReviewApiResponseBody>(
  status: number,
  body: T,
): Response {
  // SAFETY: callers pass 2xx/4xx/5xx codes (literals, HttpJsonError.statusCode,
  // BugReportUpstreamError.status); none is a bodyless 1xx/204/205/304 status.
  return jsonResponse(body, status as ContentfulStatusCode, {
    contentType: "application/json",
    newline: false,
  });
}

async function rematerializeReviewSoftwareMapArtifacts(input: {
  reviewRootPath: string;
}): Promise<{
  status: "rematerialized" | "skipped";
  headCommit?: string;
  artifactPath?: string | null;
}> {
  const review = readReviewStoreRecord(input.reviewRootPath);

  const repoRootPath = resolveReviewRepoRootFromStore(
    input.reviewRootPath,
    review,
  );

  const headCommit = review.sourceCommit
    ? (
        await resolveRevision(repoRootPath, review.sourceCommit).catch(
          () => null,
        )
      )?.commit
    : (await currentHead(repoRootPath).catch(() => null))?.commit;

  if (!headCommit) return { status: "skipped" };

  const [artifactPath] = await Promise.all([
    materializeSoftwareMapAtRef({
      repoRootPath,
      ref: headCommit,
      role: "head",
      validate: "skip",
    }),
    review.baseCommit
      ? resolveRevision(repoRootPath, review.baseCommit)
          .catch(() => null)
          .then((base) =>
            base?.commit
              ? materializeSoftwareMapAtRef({
                  repoRootPath,
                  ref: base.commit,
                  role: "base",
                  validate: "skip",
                })
              : null,
          )
      : Promise.resolve(null),
  ]);

  return { status: "rematerialized", headCommit, artifactPath };
}

async function buildSoftwareMapResolvedData(input: {
  sourceTarget: ReviewSourceTarget;
  codeElements: ReturnType<typeof parseSoftwareMapCodeElements>;
  coverageClaims: ReturnType<typeof parseSoftwareMapCoverageClaims>;
}): Promise<SoftwareMapResolvedDataResponse> {
  const diffRootPath =
    input.sourceTarget.baseRef || input.sourceTarget.headRef
      ? input.sourceTarget.diffRootPath
      : input.sourceTarget.sourceRootPath;

  const counts = await resolveSoftwareMapDiffCounts({
    sourceRootPath: diffRootPath,
    baseRef: input.sourceTarget.baseRef,
    headRef: input.sourceTarget.headRef,
    codeElements: input.codeElements,
    coverageClaims: input.coverageClaims,
  });

  return {
    countsByElementPath: counts.countsByElementPath,
    unmappedByElementPath: counts.unmappedByElementPath,
  };
}

function resolveReviewDocumentPath(
  url: URL,
  input: { reviewPath: string; reviewDocumentsDir: string },
): string | null {
  // Strict resolution, matching the client: unknown document routes render a
  // not-found page rather than silently falling back to the default review.
  return resolveReviewDocumentFilePath({
    routePath: url.searchParams.get("document"),
    reviewPath: input.reviewPath,
    reviewDocumentsDir: input.reviewDocumentsDir,
  });
}

export interface ReviewRequestDiffTarget {
  rootPath: string;
  baseRef?: string;
  headRef?: string;
}

export function resolveRequestDiffTarget(
  url: URL,
  input: {
    reviewPath: string;
    reviewDocumentsDir: string;
    rootPath: string;
    session?: ReviewSessionWire;
    record?: ReviewRecord;
  },
): ReviewRequestDiffTarget {
  const reviewDocumentPath = resolveReviewDocumentPath(url, input);

  if (!reviewDocumentPath) {
    throw new Error("Review document not found.");
  }

  const review = input.record ?? readReviewStoreRecord(input.rootPath);

  return {
    rootPath: resolveReviewRepoRootFromStore(input.rootPath, review),
    baseRef: review.baseCommit,
    headRef: review.sourceCommit ?? undefined,
  };
}
