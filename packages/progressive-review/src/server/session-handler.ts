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
import type { ReviewDocumentBundle } from "../review-bundle";
import { ReviewBusyError } from "../review-mutation-lock";
import type { ReviewThreadsService } from "../review-threads-service";
import { resolveReviewSessionBaseCommit } from "../review-worktree-target";
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
import type { ReviewSessionArtifactInput } from "./review-session-artifact";
import {
  LIVE_REVIEW_SESSION_MODE,
  type ReviewSessionMode,
  reviewSessionModeIsReadOnly,
  reviewSessionModeRecord,
} from "./review-session-mode";

const API_PREFIX = "/__progressive-review";
const DOCUMENT_PATH_PREFIX = `${API_PREFIX}/documents/`;
const MAP_PATH_PREFIX = `${API_PREFIX}/software-maps/`;

interface ReviewEventClient {
  write(frame: string): void;
  close(): void;
}

export interface ReviewSessionHandlerInput {
  rootPath: string;
  reviewRootPath?: string;
  toolingRoot: string;
  artifact: ReviewSessionArtifactInput;
  stateReviewPath?: string;
  getLiveBundle?: () => Promise<ReviewDocumentBundle | null>;
  threadsService?: () => ReviewThreadsService;
  routePath: string;
  token?: string;
  sessionId?: string;
  reviewUuid?: string;
  submitHook?: string;
  mode?: ReviewSessionMode;
  /** Set when the session's pinned source commits could not be checked out. */
  sourceUnavailable?: string;
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
  const artifact = input.artifact;
  const renderDir = path.dirname(artifact.sourcePath);
  const storageDir =
    session.storageDir ??
    path.dirname(input.stateReviewPath ?? artifact.sourcePath);
  const reviewRootPath = input.reviewRootPath ?? storageDir;
  await Promise.all([
    mkdir(renderDir, { recursive: true, mode: 0o700 }),
    mkdir(storageDir, { recursive: true, mode: 0o700 }),
  ]);
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  const sessionUrl = (session.sessionUrl ?? session.appUrl).replace(/\/$/, "");
  const documentsDir = path.join(renderDir, ".review-documents");
  const mapBundle =
    artifact.map && "bundle" in artifact.map ? artifact.map.bundle : null;
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

  /* The overlay is the author's working preview. A candidate is mounted to
     validate its own bytes and a historical revision is committed, so neither
     of them may serve it. Read per request: a candidate that is promoted
     becomes a publication origin and starts serving the preview. */
  const overlayApplies = () =>
    artifact.origin.kind !== "candidate" && mode.kind !== "historical";
  const liveBundles = new Map<string, ReviewDocumentBundle>();
  /** The host's preview, remembered by hash so an in-flight document URL
   * stays valid once the next edit replaces it. */
  const takeLiveBundle = async (): Promise<ReviewDocumentBundle | null> => {
    const live = overlayApplies() ? await input.getLiveBundle?.() : null;
    if (!live) return null;
    liveBundles.set(`${live.contentHash}.json`, live);
    if (liveBundles.size > 16)
      liveBundles.delete(liveBundles.keys().next().value!);
    return live;
  };
  const getBundle = async (): Promise<ReviewDocumentBundle | null> =>
    (await takeLiveBundle()) ??
    ("bundle" in artifact.document ? artifact.document.bundle : null);

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

  /** The map is stale when a published one cannot be served. */
  const mapIsStale = (): boolean =>
    Boolean(artifact.map && "unavailable" in artifact.map);

  /** The one 409 for an artifact the session cannot serve. */
  const artifactUnavailable = (
    kind: "document" | "map",
    message: string,
  ): Response => {
    const reviewUuid = needsRepublishReviewUuid();
    const detail: ReviewErrorDetail =
      mode.kind === "historical"
        ? { code: "historical_revision_unavailable", reviewUuid }
        : {
            code: "needs_republish",
            reviewUuid,
            mapStale: kind === "document" ? mapIsStale() : true,
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
  if (mode.kind !== "live") {
    app.use(`${API_PREFIX}/*`, async (context, next) => {
      if (!reviewSessionModeIsReadOnly(mode)) {
        await next();
        return;
      }
      const method = context.req.method;
      if (
        method === "GET" ||
        method === "HEAD" ||
        method === "OPTIONS" ||
        context.req.path.startsWith(`${API_PREFIX}/telemetry`) ||
        (method === "POST" &&
          [
            "/code-peek/resolve",
            "/software-map/resolved-data",
            "/diff-files",
          ].some((route) => context.req.path === `${API_PREFIX}${route}`))
      ) {
        await next();
        return;
      }
      return jsonResponse(
        {
          ok: false,
          error:
            mode.kind === "historical"
              ? "This historical version is read-only."
              : "This review is read-only while repair is validated.",
          code:
            mode.kind === "historical"
              ? "historical_revision"
              : "review_read_only",
        },
        409,
      );
    });
  }
  app.get(`${API_PREFIX}/session`, async () => {
    const presentedRecord = reviewSessionModeRecord(mode);
    const resolvedBaseRef = presentedRecord
      ? input.sourceUnavailable
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
    const document = artifact.document;
    if ("unavailable" in document)
      return artifactUnavailable("document", document.unavailable);
    const bundle = (await takeLiveBundle()) ?? document.bundle;
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
    const bundle =
      liveBundles.get(context.req.param("documentName")) ?? (await getBundle());
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
  app.get(`${API_PREFIX}/software-map`, () => {
    const map = artifact.map;
    if (map && "unavailable" in map)
      return artifactUnavailable("map", map.unavailable);
    if (!mapBundle) {
      return jsonResponse(
        { ok: false, error: "Software map is not published" },
        404,
      );
    }
    return jsonResponse(
      {
        ok: true,
        contentHash: mapBundle.contentHash,
        headMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}head-${mapBundle.contentHash}.json`,
        baseMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}base-${mapBundle.contentHash}.json`,
      },
      200,
    );
  });
  app.get(`${MAP_PATH_PREFIX}:mapName`, (context) => {
    const mapName = context.req.param("mapName");
    const json =
      mapName === `head-${mapBundle?.contentHash}.json`
        ? mapBundle?.headJson
        : mapName === `base-${mapBundle?.contentHash}.json`
          ? mapBundle?.baseJson
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
    sourceUnavailable: input.sourceUnavailable,
    reviewPath: artifact.sourcePath,
    documentUpdatedAtMs: () => artifact.documentUpdatedAtMs,
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
      return jsonResponse(
        {
          ok: false,
          code: "review_busy",
          retryable: true,
          error: error.message,
        },
        409,
      );
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
        .update(`${input.rootPath}\0${artifact.sourcePath}`)
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
