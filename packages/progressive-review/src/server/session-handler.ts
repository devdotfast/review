import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  type ReviewDocumentVersionWire,
  type ReviewErrorDetail,
  type ReviewRecord,
  type ReviewServerEvent,
  type ReviewSessionWire,
  type ReviewThreadsCommit,
  type ReviewVerbRequest,
  jsonString,
} from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { ReviewAgentHarness, SessionRef } from "../authoring-session";
import type { AgentServer } from "../native-agent/native-session";
import {
  type ReviewDocumentBundle,
  readReviewDocumentBundle,
} from "../review-bundle";
import { ReviewBusyError, reviewBusyResponse } from "../review-mutation-lock";
import type { ReviewThreadsService } from "../review-threads-service";
import { resolveReviewSessionBaseCommit } from "../review-worktree-target";
import {
  type ReviewSoftwareMapBundle,
  readReviewSoftwareMapBundle,
} from "../software-map-bundle";
import type {
  ProgressiveReviewTelemetry,
  ProgressiveReviewTelemetryContext,
} from "../telemetry";
import type { ReviewSubmissionEvent } from "../types";
import {
  type ReviewHonoEnv,
  applyCorsHeaders,
  corsPreflightResponse,
  isAuthorizedRequest,
  jsonResponse,
} from "./hono-http";
import { type ReviewApi, createReviewApi } from "./review-api";
import {
  LIVE_REVIEW_SESSION_MODE,
  type ReviewSessionArtifacts,
  type ReviewSessionMode,
  reviewSessionModeRecord,
} from "./review-session-mode";

const API_PREFIX = "/__progressive-review";
const DOCUMENT_PATH_PREFIX = `${API_PREFIX}/documents/`;
const MAP_PATH_PREFIX = `${API_PREFIX}/software-maps/`;
const NEEDS_REPUBLISH_ERROR =
  "This review was published by an earlier version of Review and its document must be regenerated.";
const NEEDS_REPUBLISH_MAP_ERROR =
  "This review's software map must be regenerated.";
const HISTORICAL_UNAVAILABLE_ERROR =
  "This older revision is unavailable in this version of Review";

interface ReviewEventClient {
  write(frame: string): void;
  close(): void;
}

export interface ReviewSessionHandlerInput {
  rootPath: string;
  reviewRootPath?: string;
  toolingRoot: string;
  reviewPath: string;
  softwareMapRootPath?: string;
  stateReviewPath?: string;
  threadsService?: () => ReviewThreadsService;
  routePath: string;
  token?: string;
  sessionId?: string;
  reviewUuid?: string;
  submitHook?: string;
  mode?: ReviewSessionMode;
  artifacts?: ReviewSessionArtifacts;
  readOnlyThreadsPath?: string;
  listDocumentVersions?: () => Promise<ReviewDocumentVersionWire[]>;
  session: ReviewSessionWire;
  stderr?: Writable;
  getReviewStatus?: () => ReviewRecord["status"];
  onSubmission?: (event: ReviewSubmissionEvent) => void | Promise<void>;
  onReviewDismiss?: () => void | Promise<void>;
  onReviewDataChange?: () => void;
  onReviewThreadsCommit?: (commit: ReviewThreadsCommit) => void;
  onAgentStatus?: (
    threadId: string,
    status: "running" | "idle" | "interrupted" | "failed",
    error?: string,
  ) => void;
  runReviewThreadMutation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  agentServer: (harness: ReviewAgentHarness) => AgentServer;
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
  telemetry?: ProgressiveReviewTelemetry;
}

export interface ReviewSessionHandler {
  readonly token: string;
  handle(request: Request, env?: ReviewHonoEnv["Bindings"]): Promise<Response>;
  findAgentThread: ReviewApi["findAgentThread"];
  close(): Promise<void>;
}

interface ReviewSessionHandlerDependencies {
  resolveReviewSessionBaseCommit?: typeof resolveReviewSessionBaseCommit;
}

/** Creates session-scoped state and an in-process route handler. */
export async function createReviewSessionHandler(
  input: ReviewSessionHandlerInput,
  dependencies: ReviewSessionHandlerDependencies = {},
): Promise<ReviewSessionHandler> {
  const session = input.session;
  const mode = input.mode ?? LIVE_REVIEW_SESSION_MODE;
  const artifacts = input.artifacts ?? {};
  const renderDir = path.dirname(input.reviewPath);
  const storageDir =
    session.storageDir ??
    path.dirname(input.stateReviewPath ?? input.reviewPath);
  const reviewRootPath = input.reviewRootPath ?? storageDir;
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  if (!artifacts.document)
    await mkdir(renderDir, { recursive: true, mode: 0o700 });
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  const sessionUrl = (session.sessionUrl ?? session.appUrl).replace(/\/$/, "");
  const documentsDir = path.join(renderDir, ".review-documents");
  let currentBundle: ReviewDocumentBundle | null = null;
  let bundlePromise: Promise<ReviewDocumentBundle | null> | null = null;
  let softwareMapBundlePromise: Promise<ReviewSoftwareMapBundle | null> | null =
    null;
  const eventClients = new Set<ReviewEventClient>();
  const telemetryContext: ProgressiveReviewTelemetryContext = {
    reviewUuid: input.reviewUuid,
    presentationSessionId: input.sessionId,
  };
  let reviewPresented = false;
  const sessionTelemetry = input.telemetry
    ? {
        captureTabViewed: (
          event: Parameters<ProgressiveReviewTelemetry["captureTabViewed"]>[0],
        ) => input.telemetry!.captureTabViewed(event, telemetryContext),
        captureUiEvent: async (
          event: string,
          properties: Record<string, string | number | boolean>,
        ) => {
          if (
            event === "review_review_presented" &&
            input.reviewUuid &&
            input.sessionId
          ) {
            if (reviewPresented) return;
            reviewPresented = true;
            await input.telemetry!.captureReviewPresented(
              {
                reviewUuid: input.reviewUuid,
                presentationSessionId: input.sessionId,
              },
              {
                appSessionId: jsonString(properties.app_session_id),
              },
            );
            return;
          }
          await input.telemetry!.captureUiEvent(
            event,
            properties,
            telemetryContext,
          );
        },
      }
    : undefined;

  const getBundle = async (): Promise<ReviewDocumentBundle | null> => {
    if (currentBundle) return currentBundle;
    bundlePromise ??= readReviewDocumentBundle(renderDir, input.routePath);
    try {
      currentBundle = await bundlePromise;
      return currentBundle;
    } finally {
      bundlePromise = null;
    }
  };

  const getSoftwareMapBundle = async () => {
    if (!input.softwareMapRootPath) return null;
    softwareMapBundlePromise ??= readReviewSoftwareMapBundle(
      input.softwareMapRootPath,
    );
    return softwareMapBundlePromise;
  };

  const broadcast = (event: ReviewServerEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) client.write(frame);
  };

  const needsRepublishReviewUuid = (): string => {
    if (!input.reviewUuid) {
      throw new Error("A review UUID is required to report needs_republish.");
    }
    return input.reviewUuid;
  };

  /** The map is stale when its own revision is gone, or when a published map
   * root no longer yields a readable bundle. One expression, one answer. */
  const mapIsStale = async (): Promise<boolean> =>
    Boolean(
      artifacts.map ||
      (input.softwareMapRootPath && !(await getSoftwareMapBundle())),
    );

  /** The one 409 for an artifact the session cannot serve. */
  const artifactUnavailable = async (
    kind: "document" | "map",
    message: string,
  ): Promise<Response> => {
    const reviewUuid = needsRepublishReviewUuid();
    const detail: ReviewErrorDetail =
      mode.kind === "historical"
        ? { code: "historical_revision_unavailable", reviewUuid }
        : {
            code: "needs_republish",
            reviewUuid,
            mapStale: kind === "document" ? await mapIsStale() : true,
          };
    return jsonResponse(
      {
        ok: false,
        error: message,
        detail,
      },
      409,
    );
  };

  /** The message when the artifact itself is intact but its revision is not. */
  const staleArtifactMessage = (kind: "document" | "map"): string =>
    mode.kind === "historical"
      ? HISTORICAL_UNAVAILABLE_ERROR
      : kind === "document"
        ? NEEDS_REPUBLISH_ERROR
        : NEEDS_REPUBLISH_MAP_ERROR;

  const documentUrl = (bundle: ReviewDocumentBundle): string =>
    `${sessionUrl}${DOCUMENT_PATH_PREFIX}${bundle.contentHash}.json`;

  const app = new Hono<ReviewHonoEnv>();
  app.use("*", async (context, next) => {
    await next();
    applyCorsHeaders(context.req.raw, context.res);
  });
  app.options("*", (context) => corsPreflightResponse(context.req.raw));
  app.use(`${API_PREFIX}/*`, async (context, next) => {
    if (
      context.req.method === "OPTIONS" ||
      context.req.path === `${API_PREFIX}/session`
    ) {
      await next();
      return;
    }
    if (!isAuthorizedRequest(context.req.raw, token)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }
    await next();
  });
  app.get(`${API_PREFIX}/session`, async () => {
    const presentedRecord = reviewSessionModeRecord(mode);
    const resolvedBaseRef = presentedRecord
      ? artifacts.source
        ? null
        : presentedRecord.baseCommit
      : await (
          dependencies.resolveReviewSessionBaseCommit ??
          resolveReviewSessionBaseCommit
        )({
          reviewRootPath,
        });
    const sessionPayload: ReturnType<typeof reviewSessionPayload> & {
      resolvedBaseRef: typeof resolvedBaseRef;
      reviewStatus?: ReviewRecord["status"];
    } = { ...reviewSessionPayload(), resolvedBaseRef };
    if (input.getReviewStatus) {
      sessionPayload.reviewStatus = input.getReviewStatus();
    }
    return jsonResponse({ ok: true, session: sessionPayload, token }, 200);
  });
  app.get(`${API_PREFIX}/revisions`, async () => {
    if (!input.listDocumentVersions) {
      return jsonResponse(
        { ok: false, error: "Version history is unavailable." },
        404,
      );
    }
    return jsonResponse(
      { ok: true, versions: await input.listDocumentVersions() },
      200,
    );
  });
  app.get(`${API_PREFIX}/document`, async () => {
    if (artifacts.document)
      return artifactUnavailable("document", artifacts.document);
    const bundle = await getBundle();
    if (!bundle)
      return artifactUnavailable("document", staleArtifactMessage("document"));
    return jsonResponse(
      {
        ok: true,
        contentHash: bundle.contentHash,
        documentUrl: documentUrl(bundle),
      },
      200,
    );
  });
  app.get(`${DOCUMENT_PATH_PREFIX}:documentName`, async (context) => {
    const bundle = await getBundle();
    if (
      !bundle ||
      context.req.param("documentName") !== `${bundle.contentHash}.json`
    ) {
      return jsonResponse(
        { ok: false, error: "Review document not found" },
        404,
      );
    }
    return new Response(bundle.json, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  });
  app.get(`${API_PREFIX}/software-map`, async () => {
    if (artifacts.map) return artifactUnavailable("map", artifacts.map);
    const bundle = await getSoftwareMapBundle();
    if (!bundle) {
      if (input.softwareMapRootPath)
        return artifactUnavailable("map", staleArtifactMessage("map"));
      return jsonResponse(
        { ok: false, error: "Software map is not published" },
        404,
      );
    }
    return jsonResponse(
      {
        ok: true,
        contentHash: bundle.contentHash,
        headMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}head-${bundle.contentHash}.json`,
        baseMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}base-${bundle.contentHash}.json`,
      },
      200,
    );
  });
  app.get(`${MAP_PATH_PREFIX}:mapName`, async (context) => {
    const bundle = await getSoftwareMapBundle();
    const mapName = context.req.param("mapName");
    const json =
      mapName === `head-${bundle?.contentHash}.json`
        ? bundle?.headJson
        : mapName === `base-${bundle?.contentHash}.json`
          ? bundle?.baseJson
          : undefined;
    if (!json) {
      return jsonResponse({ ok: false, error: "Software map not found" }, 404);
    }
    return new Response(json, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  });
  app.get(`${API_PREFIX}/events`, (context) => {
    context.header("cache-control", "no-cache, no-transform");
    const response = streamSSE(context, async (stream) => {
      let finish!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let pending: Promise<void> = stream
        .write(": connected\n\n")
        .then(() => undefined);
      const client: ReviewEventClient = {
        write(frame) {
          pending = pending.then(async () => {
            await stream.write(frame);
          });
        },
        close() {
          finish();
          void stream.close();
        },
      };
      stream.onAbort(finish);
      eventClients.add(client);
      const heartbeat = setInterval(
        () => client.write(": heartbeat\n\n"),
        15_000,
      );
      heartbeat.unref?.();
      try {
        await disconnected;
        await pending;
      } finally {
        clearInterval(heartbeat);
        eventClients.delete(client);
      }
    });
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  });
  const reviewApi = createReviewApi({
    mode,
    readOnlyThreadsPath: input.readOnlyThreadsPath,
    sourceUnavailable: artifacts.source,
    reviewPath: input.reviewPath,
    reviewDocumentsDir: documentsDir,
    rootPath: input.rootPath,
    reviewRootPath,
    toolingRoot: input.toolingRoot,
    stateReviewPath: input.stateReviewPath,
    threadsService: input.threadsService,
    telemetry: sessionTelemetry,
    onSubmission: async (event) => {
      broadcast({
        event: "submitted",
        submissionId: event.id,
        decision: event.decision,
      });
      await input.onSubmission?.(event);
    },
    onReviewDismiss: input.onReviewDismiss,
    onReviewDataChange: input.onReviewDataChange,
    onAgentStatus: input.onAgentStatus,
    onReviewThreadsCommit: (commit) => {
      broadcast({ event: "review-threads-committed", commit });
      input.onReviewThreadsCommit?.(commit);
    },
    runReviewThreadMutation: input.runReviewThreadMutation,
    reviewToken: token,
    agentServer: input.agentServer,
    openNativeAgentTerminal: input.openNativeAgentTerminal,
    resolveQuestionSourceSession: input.resolveQuestionSourceSession,
    onQuestionAgentSession: input.onQuestionAgentSession,
    submitHook: input.submitHook,
    session,
  });
  app.route(API_PREFIX, reviewApi.app);
  app.all(`${API_PREFIX}/*`, () =>
    jsonResponse({ ok: false, error: "not found" }, 404, {
      contentType: "application/json",
      newline: false,
    }),
  );
  app.notFound(() => jsonResponse({ ok: false, error: "Not found" }, 404));
  app.onError((error) => {
    if (error instanceof ReviewBusyError)
      return jsonResponse(reviewBusyResponse(error), 409);
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  });

  function reviewSessionPayload() {
    return {
      ...session,
      sessionId: reviewSessionId(),
      appUrl: sessionUrl,
      routePath: input.routePath,
      serverUrl: new URL(sessionUrl).origin,
      sessionUrl,
      storageDir,
    };
  }

  function reviewSessionId(): string {
    return (
      input.sessionId ??
      crypto
        .createHash("sha256")
        .update(`${input.rootPath}\0${input.reviewPath}`)
        .digest("hex")
        .slice(0, 20)
    );
  }

  return {
    token,
    findAgentThread: reviewApi.findAgentThread,
    async handle(request, env) {
      // The desktop proxy forwards its own node bindings so response-close
      // hooks (submission acks, reject teardown) observe the real socket.
      return app.fetch(request, env);
    },
    close: async () => {
      await reviewApi.close();
      for (const client of eventClients) client.close();
      eventClients.clear();
    },
  };
}
