import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import {
  type LocalVcsCommitSummary,
  currentHead,
  listCommitRange,
  resolveRevision,
} from "@dev.fast/local-vcs";
import {
  type JsonObject,
  type JsonValue,
  type ReviewCommentThreadRecord,
  type ReviewRecord,
  type ReviewSessionWire,
  type ReviewStackResponse,
  type ReviewThreadsCommit,
  type ReviewVerbRequest,
  isJsonObject,
  jsonString,
  parseReviewFileContentRequest,
} from "@dev.fast/review-protocol";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  type SessionRef,
  resolveAuthoringSessionRef,
} from "../authoring-session";
import {
  codePeekRootSourceRanges,
  sliceReviewDiffFileToCodePeekRanges,
} from "../codepeek-symbol-diff";
import { mergeErrorTelemetryProperties } from "../error-telemetry";
import { NativeMessageMirror } from "../native-agent/native-message-mirror";
import type {
  ReviewThreadAgentBinding,
  ReviewTurnRoute,
} from "../native-agent/native-session";
import { NativeReviewTurnLauncher } from "../native-agent/native-turn-launcher";
import {
  listReviewTraceSessions,
  loadReviewAgentTrace,
} from "../review-agent-traces";
import { reviewCommentPrompt } from "../review-comment-agent";
import { resolveReviewCommitScope } from "../review-commits";
import type {
  ReviewDiffFile,
  ReviewDiffFilesResult,
} from "../review-diff-files";
import {
  resolveReviewDiffFiles,
  resolveReviewFileContent,
} from "../review-diff-files";
import { listReviews } from "../review-home";
import {
  normalizeReviewRoutePath,
  resolveReviewDocumentFilePath,
} from "../review-paths";
import { resolveReviewStackLayers } from "../review-stack";
import { saveReviewSubmissionAudit } from "../review-state-store";
import { readReviewThreadsReadOnly } from "../review-thread-store-backend";
import { ReviewThreadsService } from "../review-threads-service";
import {
  readReviewStoreRecord,
  resolveReviewRepoRootFromStore,
  resolveReviewSessionBaseCommit,
  resolveReviewSourceTarget,
} from "../review-worktree-target";
import { materializeSoftwareMapAtRef } from "../software-map-artifact";
import { resolveSoftwareMapDiffCounts } from "../software-map-diff-counts";
import type { SourceSnapshot } from "../source-code-types";
import { resolveReviewSourceRange } from "../source-range-resolver";
import { readStoreAuth } from "../store-auth";
import { ProgressiveReviewTelemetry } from "../telemetry";
import type { ReviewTabTelemetryEvent } from "../telemetry";
import type { CreateReviewCommentInput, ReviewSubmissionEvent } from "../types";
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
  parseCodePeekRoot,
  parseReviewBugReportInput,
  parseReviewCommentInput,
  parseReviewDiffFilesInput,
  parseReviewSubmissionInput,
  parseReviewTabTelemetryInput,
  parseReviewThreadsCommand,
  parseSoftwareMapCodeElements,
  parseSoftwareMapCoverageClaims,
  parseUpdateReviewCommentInput,
  requestJsonErrorStatus,
} from "./review-api-parsers";

const REVIEW_SUBMIT_HOOK_ENV = "DEV_FAST_REVIEW_SUBMIT_HOOK";
export const TUTORIAL_QUESTION_SOURCE_WAIT_MS = 5_000;
const CODE_PEEK_DIFF_CONTEXT_LINES = 100_000;
const defaultTelemetry = new ProgressiveReviewTelemetry();
const MAX_CLIENT_ERROR_SESSIONS = 100;
const MAX_CLIENT_ERRORS_PER_SESSION = 20;
const clientErrorsBySession = new Map<string, string[]>();

function recordClientError(
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

function clientErrorsForSession(sessionId: string): string[] {
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

interface ReviewApiOptions {
  readOnlyReview?: ReviewRecord;
  readOnly?: () => boolean;
  sourceUnavailable?: string;
  reviewPath: string;
  reviewDocumentsDir: string;
  rootPath: string;
  reviewRootPath?: string;
  toolingRoot: string;
  stateReviewPath?: string;
  telemetry?: ReviewTelemetryCapture;
  onSubmission?: (event: ReviewSubmissionEvent) => void | Promise<void>;
  onReviewDismiss?: () => void | Promise<void>;
  onReviewDataChange?: () => void;
  onReviewThreadsCommit?: (commit: ReviewThreadsCommit) => void;
  runReviewThreadMutation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  reviewToken: string;
  reviewCliPath?: string;
  reviewCliRuntimePath?: string;
  openNativeAgentTerminal: (
    input: Extract<
      ReviewVerbRequest,
      { name: "openNativeAgentTerminal" }
    >["args"],
  ) => Promise<void>;
  resolveQuestionSourceSession?: (
    signal?: AbortSignal,
  ) => Promise<SessionRef | undefined>;
  onQuestionAgentSession?: (agent: SessionRef) => Promise<void>;
  submitHook?: string;
  session: ReviewSessionWire;
}

type ReviewApiHandler = (
  context: Context<ReviewHonoEnv>,
) => Promise<Response> | Response;

export interface ReviewApi {
  app: Hono<ReviewHonoEnv>;
  close(): Promise<void>;
}

export function createReviewApi(options: ReviewApiOptions): ReviewApi {
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
    onSubmission,
    onReviewDismiss,
    onReviewThreadsCommit,
    runReviewThreadMutation = async (operation) => operation(),
    openNativeAgentTerminal,
    resolveQuestionSourceSession,
    onQuestionAgentSession,
    submitHook,
    stateReviewPath,
    session,
  } = options;
  const agentRootPath = session.headRootPath ?? rootPath;
  const nativeTurns = new NativeReviewTurnLauncher({
    hookBaseUrl: `${(session.sessionUrl ?? session.appUrl).replace(/\/$/u, "")}/__progressive-review/native-agent-events`,
    hookToken: options.reviewToken,
    runtimeDirectory: path.join(reviewRootPath, ".native-agent"),
    reviewCliPath: options.reviewCliPath,
    reviewCliRuntimePath: options.reviewCliRuntimePath,
    openTerminal: openNativeAgentTerminal,
  });
  const threadServices = new Map<string, ReviewThreadsService>();
  const agentMirrors = new Map<string, NativeMessageMirror>();
  const launchedAgentMessageIds = new Set<string>();
  const diffCorpora = new Map<string, Promise<ReviewDiffFilesResult>>();
  const startMirror = (
    writableReviewPath: string,
    service: ReviewThreadsService,
  ): NativeMessageMirror => {
    const mirror = new NativeMessageMirror({
      observe: (binding) => nativeTurns.observe(binding),
      service,
    });
    agentMirrors.set(writableReviewPath, mirror);
    mirror.start();
    return mirror;
  };
  const threadsFor = (writableReviewPath: string): ReviewThreadsService => {
    let service = threadServices.get(writableReviewPath);
    if (!service) {
      service = new ReviewThreadsService({
        reviewPath: writableReviewPath,
        author: process.env.USER ?? "Reviewer",
        onCommit: onReviewThreadsCommit,
      });
      threadServices.set(writableReviewPath, service);
      const snapshot = service.snapshot();
      const hasAgentSession =
        Object.values(snapshot.comments).some(
          (comment) => comment.agentSession !== undefined,
        ) ||
        Object.values(snapshot.drafts).some(
          (draft) => draft.thread.agentSession !== undefined,
        );
      if (hasAgentSession) startMirror(writableReviewPath, service);
    }
    return service;
  };
  const mirrorFor = (writableReviewPath: string): NativeMessageMirror => {
    const service = threadsFor(writableReviewPath);
    return (
      agentMirrors.get(writableReviewPath) ??
      startMirror(writableReviewPath, service)
    );
  };

  // Every handler answers through the same catch, so a thrown parse or state
  // error becomes the route's JSON error response instead of a 500.
  const route =
    (handler: ReviewApiHandler): ReviewApiHandler =>
    async (context) => {
      try {
        return await handler(context);
      } catch (err) {
        return reviewApiJsonResponse(requestJsonErrorStatus(err), {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

  // Routes that write review state resolve the target document first. The
  // handler only runs once a writable path exists, so it takes one.
  const writable = (
    handler: (
      context: Context<ReviewHonoEnv>,
      writableReviewPath: string,
    ) => Promise<Response> | Response,
  ): ReviewApiHandler =>
    route((context) => {
      const writableReviewPath =
        stateReviewPath ??
        resolveWritableReviewPath(new URL(context.req.url), {
          reviewPath,
          reviewDocumentsDir,
        });
      if (!writableReviewPath) {
        return reviewApiJsonResponse(404, {
          ok: false,
          error: "Review document not found.",
        });
      }
      return handler(context, writableReviewPath);
    });

  const threadMutation = (
    handler: (
      context: Context<ReviewHonoEnv>,
      writableReviewPath: string,
    ) => Promise<Response> | Response,
  ): ReviewApiHandler =>
    writable((context, writableReviewPath) =>
      runReviewThreadMutation(() => handler(context, writableReviewPath)),
    );

  app.post("/telemetry/tab", route(telemetryTab));
  app.post("/telemetry/event", route(telemetryEvent));
  app.post("/telemetry/bug-report", route(bugReport));
  app.get("/session", route(sessionInfo));
  app.get("/comments", writable(commentsList));
  app.post("/thread-commands", threadMutation(threadCommand));
  app.post("/agent-runs", writable(agentRunCreate));
  app.post("/native-agent-events/:launchId", route(nativeAgentEvent));
  app.get(
    "/native-agent-events/:launchId/thread/:threadId",
    writable(nativeAgentThreadGet),
  );
  app.post("/comments/:threadId/agent-terminal", writable(agentTerminalOpen));
  app.post("/submissions", writable(submissionCreate));
  app.post("/dismiss", route(reviewDismiss));
  app.delete(
    "/comments/:threadId/messages/:messageId",
    threadMutation(commentMessageDelete),
  );
  app.post("/comments/:threadId", threadMutation(commentCreate));
  app.patch("/comments/:threadId", threadMutation(commentUpdate));
  app.delete("/comments/:threadId", threadMutation(commentDelete));
  app.post("/code-peek/resolve", route(codePeekResolve));
  app.post("/software-map/resolved-data", route(softwareMapResolvedData));
  app.post(
    "/software-map/artifacts/refresh",
    route(softwareMapArtifactsRefresh),
  );
  app.get("/document-meta", route(documentMeta));
  app.get("/stack", route(reviewStack));
  app.post("/diff-files", route(diffFiles));
  app.get("/file-content", route(fileContent));
  app.get("/agent-traces", route(agentTraces));
  app.get("/agent-traces/:sessionId", route(agentTraceDetail));
  app.notFound(() =>
    reviewApiJsonResponse(404, { ok: false, error: "not found" }),
  );

  async function resolveTraceSessionDescriptors() {
    const review =
      options.readOnlyReview ?? readReviewStoreRecord(reviewRootPath);
    const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath, review);
    const headCommit = review.sourceCommit ?? review.baseCommit;
    return listReviewTraceSessions({
      rootPath: repoRootPath,
      baseCommit: review.baseCommit,
      headCommit,
    });
  }

  async function agentTraces(): Promise<Response> {
    const sessions = await resolveTraceSessionDescriptors();
    return reviewApiJsonResponse(200, {
      ok: true,
      configured: (await readStoreAuth()) !== null,
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
    const trace =
      new URL(context.req.url).searchParams.get("trace") ?? undefined;
    const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath);
    const loaded = await loadReviewAgentTrace({
      sessionId,
      trace,
      cwd: repoRootPath,
    });
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

  function commentsList(
    _context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Response {
    return reviewApiJsonResponse(200, {
      ok: true,
      snapshot:
        options.readOnlyReview || options.readOnly?.()
          ? readReviewThreadsReadOnly(writableReviewPath)
          : threadsFor(writableReviewPath).snapshot(),
    });
  }

  async function threadCommand(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const command = parseReviewThreadsCommand(await readJson(context.req.raw));
    const commit = threadsFor(writableReviewPath).dispatch(command);
    return reviewApiJsonResponse(
      commit ? 200 : 404,
      commit
        ? { ok: true, commit }
        : { ok: false, error: "Comment thread not found." },
    );
  }

  async function agentRunCreate(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const comment = parseReviewCommentInput(await readJson(context.req.raw));
    const service = threadsFor(writableReviewPath);
    const draft = service.snapshot().drafts[comment.threadId];
    if (!draft?.inputs.some((input) => input.messageId === comment.messageId)) {
      return reviewApiJsonResponse(409, {
        ok: false,
        error: "The Review agent comment is not in the durable draft store.",
      });
    }
    if (launchedAgentMessageIds.has(comment.messageId)) {
      return reviewApiJsonResponse(202, { ok: true });
    }
    launchedAgentMessageIds.add(comment.messageId);
    const mirror = mirrorFor(writableReviewPath);
    try {
      await answerReviewComment({
        comment,
        rootPath: agentRootPath,
        session,
        service,
        mirror,
        nativeTurns,
        resolveQuestionSourceSession,
        onQuestionAgentSession,
      });
    } catch (error) {
      launchedAgentMessageIds.delete(comment.messageId);
      throw error;
    }
    return reviewApiJsonResponse(202, { ok: true });
  }

  async function nativeAgentEvent(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const launchId = context.req.param("launchId");
    if (!launchId) return reviewApiJsonResponse(200, { ok: true });
    try {
      nativeTurns.observer.acceptEvent(
        launchId,
        await readBoundedRequestJson(context.req.raw, 2 * 1024 * 1024, {}),
      );
    } catch (error) {
      nativeTurns.observer.observerFailed(launchId, error);
    }
    return reviewApiJsonResponse(200, { ok: true });
  }

  function nativeAgentThreadGet(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Response {
    const threadId = context.req.param("threadId");
    if (!threadId) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: "Comment thread not found.",
      });
    }
    const snapshot = threadsFor(writableReviewPath).snapshot();
    const draft = snapshot.drafts[threadId];
    const comment = snapshot.comments[threadId];
    if (!draft && !comment) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: `Comment thread not found: ${threadId}`,
      });
    }
    return reviewApiJsonResponse(200, {
      review: path.basename(path.dirname(writableReviewPath)),
      state: draft ? "draft" : "submitted",
      comment: draft?.thread ?? comment,
    });
  }

  async function agentTerminalOpen(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const threadId = context.req.param("threadId");
    if (!threadId) {
      return reviewApiJsonResponse(400, {
        ok: false,
        error: "Thread ID is required.",
      });
    }
    const snapshot = threadsFor(writableReviewPath).snapshot();
    const agentSession =
      snapshot.drafts[threadId]?.thread.agentSession ??
      snapshot.comments[threadId]?.agentSession;
    if (!agentSession) {
      return reviewApiJsonResponse(404, {
        ok: false,
        error: "This thread has no agent terminal.",
      });
    }
    await nativeTurns.openSession({
      launchId: randomUUID(),
      cwd: agentRootPath,
      binding: agentSession,
    });
    return reviewApiJsonResponse(200, { ok: true });
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

  async function submissionCreate(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const url = new URL(context.req.url);
    const body = parseReviewSubmissionInput(await readJson(context.req.raw));
    await runReviewThreadMutation(() =>
      threadsFor(writableReviewPath).submitDrafts(
        body.submissionId,
        body.comments,
      ),
    );
    const event = buildReviewSubmissionEvent({
      submission: body,
      rootPath,
      reviewPath: writableReviewPath,
      documentRoute: normalizeReviewRoutePath(url.searchParams.get("document")),
      session,
    });
    // Durable audit trail (best-effort — a write failure must never discard
    // an otherwise-valid submission).
    try {
      saveReviewSubmissionAudit(event.reviewPath, event);
    } catch (error) {
      console.error(error);
    }
    // Resolve the in-memory desktop submission before the response so a
    // browser tab close cannot race the durable review status.
    await onSubmission?.(event);
    await captureSanitizedUiTelemetry(
      telemetry,
      context.req.raw,
      "review_submitted",
      {
        decision: body.decision,
        comment_count: body.comments.length,
      },
      recordClientError,
    );
    const response = reviewApiJsonResponse(200, {
      ok: true,
      event,
      hook: { configured: Boolean(submitHook?.trim()) },
    });
    void runReviewSubmissionHook(event, submitHook).then((hook) => {
      if (hook.error) console.error(hook.error);
    });
    return response;
  }

  function commentMessageDelete(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Response {
    const commit = threadsFor(writableReviewPath).dispatch({
      command: "comment-message.delete",
      mutationId: randomUUID(),
      threadId: context.req.param("threadId") ?? "",
      messageId: context.req.param("messageId") ?? "",
    });
    return reviewApiJsonResponse(
      commit ? 200 : 404,
      commit
        ? { ok: true, commit }
        : { ok: false, error: "Comment message not found." },
    );
  }

  async function commentCreate(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const threadId = context.req.param("threadId") ?? "";
    const body = parseReviewCommentInput(await readJson(context.req.raw));
    if (threadId !== body.threadId) {
      throw new Error("Comment path threadId must match body threadId.");
    }
    const commit = threadsFor(writableReviewPath).dispatch({
      command: "comment.create",
      mutationId: body.messageId,
      input: body,
    });
    if (!commit) {
      throw new Error("The comment could not be created.");
    }
    return reviewApiJsonResponse(200, { ok: true, commit });
  }

  async function commentUpdate(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Promise<Response> {
    const threadId = context.req.param("threadId") ?? "";
    const body = parseUpdateReviewCommentInput(await readJson(context.req.raw));
    const commit = threadsFor(writableReviewPath).dispatch({
      command: "comment.update",
      mutationId: randomUUID(),
      threadId,
      update: body,
    });
    return reviewApiJsonResponse(
      commit ? 200 : 404,
      commit
        ? { ok: true, commit }
        : { ok: false, error: "Comment thread not found." },
    );
  }

  function commentDelete(
    context: Context<ReviewHonoEnv>,
    writableReviewPath: string,
  ): Response {
    const threadId = context.req.param("threadId") ?? "";
    const commit = threadsFor(writableReviewPath).dispatch({
      command: "comment.delete",
      mutationId: randomUUID(),
      threadId,
    });
    return reviewApiJsonResponse(
      commit ? 200 : 404,
      commit
        ? { ok: true, commit }
        : { ok: false, error: "Comment thread not found." },
    );
  }

  async function codePeekResolve(
    context: Context<ReviewHonoEnv>,
  ): Promise<Response> {
    const body = await readJsonObject(context.req.raw);
    const sourceTarget = await requestSourceTarget();
    const baseSourceTarget = sourceTarget.preparedBase;
    const graph = parseCodePeekGraph(body.graph);
    const includeDiff = body.includeDiff === true;
    const includeDiffSummary = body.includeDiffSummary === true;
    const primaryTarget = graph === "base" ? baseSourceTarget : sourceTarget;
    if (!primaryTarget) {
      throw new Error("The pinned base worktree is unavailable.");
    }
    const snapshot = await resolveReviewSourceRange({
      rootPath: primaryTarget.sourceRootPath,
      root: parseCodePeekRoot(body.root),
    });
    const diff =
      includeDiff || includeDiffSummary
        ? await resolveCodePeekDiff({
            snapshot,
            sourceTarget,
            graph,
            includePatch: includeDiff,
          })
        : undefined;
    return reviewApiJsonResponse(
      200,
      diff ? { ok: true, snapshot, diff } : { ok: true, snapshot },
    );
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
    const current =
      options.readOnlyReview ?? readReviewStoreRecord(reviewRootPath);
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
      record: options.readOnlyReview,
    });
    if (!commit) return target;
    const review =
      options.readOnlyReview ?? readReviewStoreRecord(reviewRootPath);
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

  async function requestSourceTarget() {
    if (!options.readOnlyReview)
      return resolveRequestSourceTarget({ reviewRootPath });
    if (options.sourceUnavailable) throw new Error(options.sourceUnavailable);
    if (!session.headRootPath || !session.baseRootPath)
      throw new Error("The pinned source worktrees are unavailable.");
    return {
      repoRoot: rootPath,
      sourceRootPath: session.headRootPath,
      diffRootPath: rootPath,
      headRef: options.readOnlyReview.sourceCommit ?? undefined,
      baseRef: options.readOnlyReview.baseCommit,
      preparedBase: {
        ref: options.readOnlyReview.baseCommit,
        sourceRootPath: session.baseRootPath,
      },
    };
  }

  return {
    app,
    close: async () => {
      await Promise.allSettled(
        [...agentMirrors.values()].map((mirror) => mirror.close()),
      );
      agentMirrors.clear();
    },
  };
}

function parseCodePeekGraph(value: JsonValue): "head" | "base" {
  return value === "base" ? "base" : "head";
}

function parseCodePeekIncludeDiff(value: JsonValue): boolean {
  return value === true;
}

function parseCodePeekIncludeDiffSummary(value: JsonValue): boolean {
  return value === true;
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

/** The native-agent thread lookup answers with the thread record itself. */
interface ReviewApiThreadBody {
  review: string;
  state: "draft" | "submitted";
  comment: ReviewCommentThreadRecord;
}

type ReviewApiResponseBody =
  | ReviewApiStatusBody
  | ReviewApiThreadBody
  | ReviewStackResponse;

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

async function answerReviewComment(input: {
  comment: CreateReviewCommentInput;
  rootPath: string;
  session: ReviewSessionWire;
  service: ReviewThreadsService;
  mirror: NativeMessageMirror;
  nativeTurns: NativeReviewTurnLauncher;
  resolveQuestionSourceSession?: (
    signal?: AbortSignal,
  ) => Promise<SessionRef | undefined>;
  onQuestionAgentSession?: (agent: SessionRef) => Promise<void>;
}): Promise<void> {
  const agent = input.session.agent;
  const snapshot = input.service.snapshot();
  const storedSession =
    snapshot.drafts[input.comment.threadId]?.thread.agentSession ??
    snapshot.comments[input.comment.threadId]?.agentSession;
  const route = await resolveReviewQuestionRoute({
    storedSession,
    agent,
    freshQuestionHarness: input.session.freshQuestionHarness,
    resolveQuestionSourceSession: input.resolveQuestionSourceSession,
  });
  if (!route) {
    throw new Error("This Review has no authoring agent session.");
  }
  const handle = await input.nativeTurns.launchTurn({
    launchId: randomUUID(),
    threadId: input.comment.threadId,
    reviewMessageId: input.comment.messageId,
    cwd: input.rootPath,
    prompt: reviewCommentPrompt(input.comment),
    route,
  });
  try {
    const accepted = await acceptedNativeSession(handle.accepted);
    const binding = storedSession ?? accepted;
    if (
      accepted.harness !== binding.harness ||
      accepted.sessionId !== binding.sessionId
    ) {
      throw new Error(
        `The native terminal opened session "${accepted.sessionId}" instead of "${binding.sessionId}".`,
      );
    }
    const commit = input.service.setAgentSession({
      mutationId: randomUUID(),
      threadId: input.comment.threadId,
      agentSession: binding,
    });
    if (!commit) {
      throw new Error(
        `Review comment thread ${input.comment.threadId} no longer exists.`,
      );
    }
    input.mirror.watch(input.comment.threadId, binding);
    await input.onQuestionAgentSession?.(accepted);
    void observeNativeTerminalEvents(handle).catch((error) =>
      console.error(error),
    );
  } catch (error) {
    await handle.detach();
    throw error;
  }
}

export async function resolveReviewQuestionRoute(input: {
  storedSession?: ReviewThreadAgentBinding;
  agent?: SessionRef;
  freshQuestionHarness?: ReviewSessionWire["freshQuestionHarness"];
  resolveQuestionSourceSession?: (
    signal?: AbortSignal,
  ) => Promise<SessionRef | undefined>;
}): Promise<ReviewTurnRoute | undefined> {
  if (input.storedSession) {
    return { kind: "resume", session: input.storedSession };
  }
  if (input.agent) return { kind: "fork", source: input.agent };
  const preparedSource = input.resolveQuestionSourceSession
    ? await resolveQuestionSourceWithinBudget(
        input.resolveQuestionSourceSession,
      )
    : undefined;
  if (preparedSource) return { kind: "fork", source: preparedSource };
  return input.freshQuestionHarness
    ? { kind: "new", harness: input.freshQuestionHarness }
    : undefined;
}

async function resolveQuestionSourceWithinBudget(
  resolveSource: (signal?: AbortSignal) => Promise<SessionRef | undefined>,
): Promise<SessionRef | undefined> {
  const signal = AbortSignal.timeout(TUTORIAL_QUESTION_SOURCE_WAIT_MS);
  const timedOut = new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  return Promise.race([resolveSource(signal).catch(() => undefined), timedOut]);
}

async function acceptedNativeSession<T>(accepted: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      accepted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "The native agent did not report its session within 60 seconds.",
              ),
            ),
          60_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function observeNativeTerminalEvents(
  handle: Awaited<ReturnType<NativeReviewTurnLauncher["launchTurn"]>>,
): Promise<void> {
  for await (const event of handle.events) {
    if (event.type === "session.mismatch") {
      throw new Error(
        `The native terminal changed from session "${event.expectedSessionId}" to "${event.actualSessionId}".`,
      );
    }
    if (event.type === "observer.failed") throw new Error(event.error);
  }
}

function buildReviewSubmissionEvent(input: {
  submission: ReturnType<typeof parseReviewSubmissionInput>;
  rootPath: string;
  reviewPath: string;
  documentRoute: string;
  session?: ReviewSessionWire;
}): ReviewSubmissionEvent {
  const session = input.session;
  const agent = session?.agent ?? resolveAuthoringSessionRef(process.env);
  return {
    id: input.submission.submissionId,
    decision: input.submission.decision,
    createdAt: new Date().toISOString(),
    rootPath: input.rootPath,
    reviewPath: input.reviewPath,
    documentRoute: input.documentRoute,
    appUrl: session?.appUrl,
    baseRef: session?.baseRef,
    headRef: session?.headRef,
    pullRequestNumber: session?.pullRequestNumber,
    agent,
    codexThreadId:
      session?.codexThreadId ??
      (agent?.harness === "codex"
        ? agent.sessionId
        : process.env.CODEX_THREAD_ID),
    comments: input.submission.comments,
    prompt: reviewSubmissionPrompt({
      rootPath: input.rootPath,
      reviewPath: input.reviewPath,
      appUrl: session?.appUrl,
      comments: input.submission.comments,
    }),
  };
}

function reviewSubmissionPrompt(input: {
  rootPath: string;
  reviewPath: string;
  appUrl?: string;
  comments: CreateReviewCommentInput[];
}): string {
  const commentLines = input.comments
    .map((comment, index) => {
      return `${index + 1}. Thread ${comment.threadId} targeting ${JSON.stringify(comment.target)}: ${comment.body}`;
    })
    .join("\n");
  return `The reviewer submitted comments in the progressive review.

Repo root: ${input.rootPath}
Review document: ${input.reviewPath}
Review app: ${input.appUrl ?? "unknown"}

Read the review document, inspect the submitted comments, and make the requested code or review changes. Use \`review threads list\` (run in the repo root) as canonical thread state, and mark addressed threads with \`review threads resolve <threadId>\`. Do not edit the thread storage beside the review document by hand.

You must close every open comment thread before you re-publish. Run \`review threads list\` again after you resolve the addressed threads. Do not run \`review publish\` while any comment thread is open.

Submitted comments:
${commentLines}`;
}

async function runReviewSubmissionHook(
  event: ReviewSubmissionEvent,
  configuredCommand?: string,
): Promise<{
  configured: boolean;
  exitCode?: number;
  error?: string;
}> {
  const command = configuredCommand?.trim();
  if (!command) return { configured: false };
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: event.rootPath,
      env: process.env,
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (result: {
      configured: boolean;
      exitCode?: number;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish({
        configured: true,
        error: `${REVIEW_SUBMIT_HOOK_ENV} timed out after 10s`,
      });
    }, 10_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish({ configured: true, error: error.message });
    });
    child.once("close", (code) => {
      const result: Parameters<typeof finish>[0] = {
        configured: true,
        exitCode: code ?? 1,
      };
      if (code !== 0) {
        result.error = stderr.trim() || `${REVIEW_SUBMIT_HOOK_ENV} failed`;
      }
      finish(result);
    });
    child.stdin?.end(`${JSON.stringify(event)}\n`);
  });
}

function resolveWritableReviewPath(
  url: URL,
  input: { reviewPath: string; reviewDocumentsDir: string },
): string | null {
  return resolveReviewDocumentPath(url, input);
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
                })
              : null,
          )
      : Promise.resolve(null),
  ]);
  return { status: "rematerialized", headCommit, artifactPath };
}

async function resolveRequestSourceTarget(input: { reviewRootPath: string }) {
  return resolveReviewSourceTarget({
    reviewRootPath: input.reviewRootPath,
  });
}

interface CodePeekDiffResponse {
  baseRef?: string;
  headRef?: string;
  orientation: "head" | "base";
  files: CodePeekDiffFile[];
}

interface CodePeekDiffFile {
  path: string;
  previousPath?: string;
  status: ReviewDiffFile["status"];
  additions: number;
  deletions: number;
  patch?: string;
}

async function resolveCodePeekDiff(input: {
  snapshot: SourceSnapshot;
  sourceTarget: Awaited<ReturnType<typeof resolveRequestSourceTarget>>;
  graph: "head" | "base";
  includePatch: boolean;
}): Promise<CodePeekDiffResponse | undefined> {
  if (!input.sourceTarget.baseRef) return undefined;

  const ranges = codePeekRootSourceRanges(input.snapshot);
  const paths = codePeekDiffRangeFiles(ranges);
  if (paths.length === 0) return undefined;

  const diffRootPath =
    input.sourceTarget.baseRef || input.sourceTarget.headRef
      ? input.sourceTarget.diffRootPath
      : input.sourceTarget.sourceRootPath;
  const diffFiles = await resolveCodePeekDiffFiles({
    diffRootPath,
    baseRef: input.sourceTarget.baseRef,
    headRef: input.sourceTarget.headRef,
    paths,
  });
  if (diffFiles.length === 0) return undefined;
  const files = diffFiles
    .map((file) =>
      sliceReviewDiffFileToCodePeekRanges({
        file,
        ranges,
        orientation: input.graph,
        contextLines: 0,
      }),
    )
    .filter((file): file is ReviewDiffFile => file !== null);
  if (files.length === 0) return undefined;

  return {
    baseRef: input.sourceTarget.baseRef,
    headRef: input.sourceTarget.headRef,
    orientation: input.graph,
    files: files.map((file) =>
      serializeCodePeekDiffFile(file, input.includePatch),
    ),
  };
}

async function resolveCodePeekDiffFiles(input: {
  diffRootPath: string;
  baseRef?: string;
  headRef?: string;
  paths: string[];
}): Promise<ReviewDiffFile[]> {
  return resolveReviewDiffFiles({
    rootPath: input.diffRootPath,
    baseRef: input.baseRef,
    headRef: input.headRef,
    contextLines: CODE_PEEK_DIFF_CONTEXT_LINES,
    paths: input.paths,
  }).then((diff) => diff.files);
}

export function serializeCodePeekDiffFile(
  file: ReviewDiffFile,
  includePatch: boolean,
): CodePeekDiffFile {
  const serialized: CodePeekDiffFile = {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
  if (includePatch) serialized.patch = file.patch ?? "";
  return serialized;
}

function codePeekDiffRangeFiles(
  ranges: ReturnType<typeof codePeekRootSourceRanges>,
): string[] {
  return [
    ...new Set(
      ranges
        .map((range) => range.file)
        .filter((file) => file.trim().length > 0),
    ),
  ].sort();
}

async function buildSoftwareMapResolvedData(input: {
  sourceTarget: Awaited<ReturnType<typeof resolveRequestSourceTarget>>;
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
