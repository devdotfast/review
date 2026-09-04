import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  type ReviewDocumentVersionWire,
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
import { readReviewDocumentBundle } from "../review-bundle";
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
import type { ReviewDocumentBundle } from "./doc-bundler";
import {
  type ReviewHonoEnv,
  applyCorsHeaders,
  corsPreflightResponse,
  isAuthorizedRequest,
  jsonResponse,
} from "./hono-http";
import { type ReviewApi, createReviewApi } from "./review-api";

const API_PREFIX = "/__progressive-review";
const MODULE_PATH_PREFIX = `${API_PREFIX}/doc-modules/`;
const MAP_MODULE_PATH_PREFIX = `${API_PREFIX}/software-map-modules/`;

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
  routePath: string;
  token?: string;
  sessionId?: string;
  reviewUuid?: string;
  submitHook?: string;
  historicalRevision?: string;
  listDocumentVersions?: () => Promise<ReviewDocumentVersionWire[]>;
  session: ReviewSessionWire;
  stderr?: Writable;
  getReviewStatus?: () => ReviewRecord["status"];
  onSubmission?: (event: ReviewSubmissionEvent) => void | Promise<void>;
  onReviewDismiss?: () => void | Promise<void>;
  onReviewDataChange?: () => void;
  onReviewThreadsCommit?: (commit: ReviewThreadsCommit) => void;
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
  const renderDir = path.dirname(input.reviewPath);
  const storageDir =
    session.storageDir ??
    path.dirname(input.stateReviewPath ?? input.reviewPath);
  const reviewRootPath = input.reviewRootPath ?? storageDir;
  await Promise.all([
    mkdir(renderDir, { recursive: true, mode: 0o700 }),
    mkdir(storageDir, { recursive: true, mode: 0o700 }),
  ]);
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  const sessionUrl = (session.sessionUrl ?? session.appUrl).replace(/\/$/, "");
  const documentsDir = path.join(renderDir, ".review-documents");
  let currentBundle: ReviewDocumentBundle | null = null;
  let bundlePromise: Promise<ReviewDocumentBundle> | null = null;
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

  const getBundle = async (): Promise<ReviewDocumentBundle> => {
    if (currentBundle) return currentBundle;
    bundlePromise ??= (async () => {
      const bundle = await readReviewDocumentBundle(renderDir, input.routePath);
      if (!bundle) {
        throw new Error(
          "The published Review document bundle is missing. Run `review migrate apply`.",
        );
      }
      return bundle;
    })();
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

  const moduleUrl = (bundle: ReviewDocumentBundle): string =>
    `${sessionUrl}${MODULE_PATH_PREFIX}${bundle.contentHash}.js`;

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
  if (input.historicalRevision) {
    app.use(`${API_PREFIX}/*`, async (context, next) => {
      const method = context.req.method;
      if (
        method === "GET" ||
        method === "HEAD" ||
        method === "OPTIONS" ||
        context.req.path.startsWith(`${API_PREFIX}/telemetry`)
      ) {
        await next();
        return;
      }
      return jsonResponse(
        {
          ok: false,
          error: "This historical version is read-only.",
          code: "historical_revision",
        },
        409,
      );
    });
  }
  app.get(`${API_PREFIX}/session`, async () => {
    const resolvedBaseRef = await (
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
  app.get(`${API_PREFIX}/doc-module`, async () => {
    const bundle = await getBundle();
    return jsonResponse(
      {
        ok: true,
        contentHash: bundle.contentHash,
        moduleUrl: moduleUrl(bundle),
      },
      200,
    );
  });
  app.get(`${MODULE_PATH_PREFIX}:moduleName`, async (context) => {
    const bundle = await getBundle();
    if (context.req.param("moduleName") !== `${bundle.contentHash}.js`) {
      return jsonResponse(
        { ok: false, error: "Document module not found" },
        404,
      );
    }
    return new Response(bundle.code, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  });
  app.get(`${API_PREFIX}/software-map-module`, async () => {
    const bundle = await getSoftwareMapBundle();
    if (!bundle) {
      return jsonResponse(
        { ok: false, error: "Software map is not published" },
        404,
      );
    }
    return jsonResponse(
      {
        ok: true,
        contentHash: bundle.contentHash,
        headModuleUrl: `${sessionUrl}${MAP_MODULE_PATH_PREFIX}head-${bundle.contentHash}.js`,
        baseModuleUrl: `${sessionUrl}${MAP_MODULE_PATH_PREFIX}base-${bundle.contentHash}.js`,
      },
      200,
    );
  });
  app.get(`${MAP_MODULE_PATH_PREFIX}:moduleName`, async (context) => {
    const bundle = await getSoftwareMapBundle();
    const moduleName = context.req.param("moduleName");
    const code =
      moduleName === `head-${bundle?.contentHash}.js`
        ? bundle?.headCode
        : moduleName === `base-${bundle?.contentHash}.js`
          ? bundle?.baseCode
          : undefined;
    if (!code) {
      return jsonResponse(
        { ok: false, error: "Software map module not found" },
        404,
      );
    }
    return new Response(code, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
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
    reviewPath: input.reviewPath,
    reviewDocumentsDir: documentsDir,
    rootPath: input.rootPath,
    reviewRootPath,
    toolingRoot: input.toolingRoot,
    stateReviewPath: input.stateReviewPath,
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
  app.onError((error) =>
    jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    ),
  );

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
