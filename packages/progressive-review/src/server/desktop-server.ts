import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDescriptor,
  type ReviewDesktopDiscovery,
  type ReviewDesktopGlobalEvent,
  type ReviewRecord,
  type ReviewSessionDescriptor,
  type ReviewSessionLifecycleEvent,
  type ReviewSessionWire,
  type ReviewTutorialOpenResponse,
  type ReviewVerbRequest,
  type ReviewView,
  parseReviewCliInstallApplyRequest,
  parseReviewPublishReadyRequest,
  reviewViewSchema,
} from "@dev.fast/review-protocol";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  type ReviewAgentHarness,
  type SessionRef,
  authoringSessionKey,
  parseAuthoringSessionKey,
  parseFreshSourceSessionHarness,
} from "../authoring-session";
import { preferredInstalledReviewAgent } from "../installed-review-agent";
import { readProgressiveReviewPackageVersion } from "../package-paths";
import {
  type ProgressiveReviewSessionAgent,
  type ProgressiveReviewSourceKind,
  ProgressiveReviewTelemetry,
} from "../progressive-review-telemetry";
import {
  dismissReview,
  markReviewViewed,
  restoreReview,
  reviewReapsAt,
  selectReapableReviews,
} from "../review-attention";
import { listReviewDocumentVersions } from "../review-document-versions";
import {
  ensureReviewPinnedCheckout,
  removeReviewManagedCheckouts,
} from "../review-head-checkout";
import {
  type StoredReview,
  type StoredReviewRecord,
  bindReviewAuthorSession,
  countReviewComments,
  findReview,
  listReviews,
  parseStoredReviewRecord,
  reviewDescriptor,
  reviewTitleFromDocument,
  reviewsHomeDir,
  touchReviewAgentSession,
} from "../review-home";
import type { RunReviewInfoInput } from "../review-info";
import {
  readReviewPreferences,
  writeReviewPreferences,
} from "../review-preferences";
import {
  ReviewOpenThreadsError,
  requireClosedThreadsForRepublish,
} from "../review-publish-thread-gate";
import { clearReopenPending, markReopenPending } from "../review-reopen-marker";
import { devReviewHome } from "../review-storage";
import { readReviewSoftwareMapBundle } from "../software-map-bundle";
import { createTutorialAuthoringSession } from "../tutorial-authoring-session";
import type { ReviewSubmissionEvent } from "../types";
import {
  REVIEW_APP_SESSION_ID_HEADER,
  isValidReviewAppSessionId,
} from "../ui-telemetry-events";
import {
  applyCliInstall,
  declineCliInstall,
  removeCliInstall,
  resetCliInstall,
  resolveCliInstallStatus,
  resolveInstalledReviewAgentStatus,
  skipCliInstall,
} from "./cli-install";
import {
  reviewDesktopDiscoveryPath,
  writePrivateJsonAtomic,
} from "./desktop-paths";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay";
import {
  type ReviewHonoEnv,
  applyCorsHeaders,
  corsPreflightResponse,
  createNodeRequestListener,
  isAuthorizedRequest,
  jsonResponse,
  readBoundedRequestJson,
} from "./hono-http";
import { HttpJsonError } from "./http-json";
import { ReviewLifecycleRegistry } from "./lifecycle-registry";
import { materializePublishRevision } from "./publish-stage";
import { captureSanitizedUiTelemetry } from "./review-api";
import { resolveReviewInfo } from "./review-info";
import {
  type ReviewSessionHandler,
  createReviewSessionHandler,
} from "./session-handler";
import { createTutorialService } from "./tutorial-service";

const DEFAULT_CAPACITY = 16;
const REVIEW_REAPER_INTERVAL_MS = 60 * 60 * 1_000;
const TUTORIAL_LIFECYCLE_LOCK_KEY = "tutorial-lifecycle";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReviewDesktopEventClient {
  write(frame: string): void;
  close(): void;
}

interface ActiveReviewSession {
  descriptor: ReviewSessionDescriptor;
  review: StoredReview;
  documentPath: string;
  softwareMapRootPath?: string;
  revision?: string;
  historicalRevision?: string;
  source?: {
    sourceCommit: string;
    sourceBranch: string;
  };
  handler: ReviewSessionHandler;
  promoted: boolean;
  closing: boolean;
  telemetryStarted: boolean;
  telemetryEnded: boolean;
  appSessionId?: string;
  tutorialPreparation?: PreparedTutorial;
  resolveQuestionSourceSession?: (
    signal?: AbortSignal,
  ) => Promise<SessionRef | undefined>;
}

interface RegisterSessionInput {
  review: StoredReview;
  documentPath: string;
  softwareMapRootPath?: string;
  revision?: string;
  historicalRevision?: string;
  source?: ActiveReviewSession["source"];
  appSessionId?: string;
  promoted: boolean;
  announce?: boolean;
  focusCanvas?: boolean;
  view?: ReviewView;
  // True when opened for a non-document surface (the Source tab). Stamped on
  // the session-registered broadcast so the app suppresses the document tab.
  background?: boolean;
  checkoutRoots?: ReviewCheckoutRoots;
  tutorialPreparation?: PreparedTutorial;
  resolveQuestionSourceSession?: (
    signal?: AbortSignal,
  ) => Promise<SessionRef | undefined>;
}

interface ReviewCheckoutRoots {
  baseRootPath: string;
  headRootPath: string;
}

function revealVerb(view?: ReviewView): ReviewVerbRequest {
  return view
    ? { name: "showReviewView", args: { view } }
    : { name: "focusCanvas", args: {} };
}

interface PreparedTutorial {
  review: StoredReview;
  documentPath: string;
  softwareMapRootPath: string;
  checkoutRoots: ReviewCheckoutRoots;
  harness: ReviewAgentHarness;
}

interface TutorialAuthoringState {
  attempts: number;
  session?: SessionRef;
  operation?: {
    controller: AbortController;
    promise: Promise<SessionRef | undefined>;
  };
}

class ReviewServerError extends Error {
  override readonly name = "ReviewServerError";

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface GlobalReviewServerInput {
  appPid: number;
  packageRoot: string;
  toolingRoot: string;
  cliRuntimePath?: string;
  port: number;
  token?: string;
  instanceId?: string;
  discoveryPath?: string;
  lifecycle?: ReviewLifecycleRegistry;
  capacity?: number;
  sessionHandlerFactory?: typeof createReviewSessionHandler;
  tutorialAuthoringSessionFactory?: typeof createTutorialAuthoringSession;
  tutorialAuthorSessionBinder?: typeof bindReviewAuthorSession;
  tutorialAgentResolver?: () => Promise<ReviewAgentHarness | undefined>;
  publishRuntime?: {
    materializePublishRevision: typeof materializePublishRevision;
  };
  telemetry?: ProgressiveReviewTelemetry;
  developmentModule?: ReviewDesktopDevelopmentModule;
}

export interface ReviewDesktopDevelopmentModule {
  routePath: string;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface GlobalReviewServer {
  readonly discovery: ReviewDesktopDiscovery;
  readonly url: string;
  listen(): Promise<void>;
  close(reason?: "app-exit"): Promise<void>;
}

export function createGlobalReviewServer(
  input: GlobalReviewServerInput,
): GlobalReviewServer {
  const instanceId = input.instanceId ?? crypto.randomUUID();
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  // Port 0 asks the OS to choose, so nothing may assume the requested port is
  // the bound one until listen() has resolved.
  let boundPort = input.port;
  const urlForBoundPort = () => `http://127.0.0.1:${boundPort}`;
  const discoveryPath = input.discoveryPath ?? reviewDesktopDiscoveryPath();
  const lifecycle = input.lifecycle ?? new ReviewLifecycleRegistry();
  const capacity = input.capacity ?? DEFAULT_CAPACITY;
  const sessionHandlerFactory =
    input.sessionHandlerFactory ?? createReviewSessionHandler;
  const tutorialAuthoringSessionFactory =
    input.tutorialAuthoringSessionFactory ?? createTutorialAuthoringSession;
  const tutorialAuthorSessionBinder =
    input.tutorialAuthorSessionBinder ?? bindReviewAuthorSession;
  const tutorialAgentResolver =
    input.tutorialAgentResolver ??
    (async () =>
      preferredInstalledReviewAgent(await resolveInstalledReviewAgentStatus()));
  const publishRuntime = input.publishRuntime ?? {
    materializePublishRevision,
  };
  const telemetry = input.telemetry ?? ProgressiveReviewTelemetry.fromEnv();
  const relay = new GlobalReviewDesktopVerbRelay();
  const sessions = new Map<string, ActiveReviewSession>();
  const reviewLocks = new Map<string, Promise<void>>();
  const globalClients = new Set<ReviewDesktopEventClient>();
  const tutorial = createTutorialService({
    packageRoot: input.packageRoot,
    deleteReview: deleteStoredReview,
  });
  let preparedTutorial: PreparedTutorial | null = null;
  const tutorialAuthoringStates = new Map<string, TutorialAuthoringState>();
  let reviewReaper: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  const openNativeAgentTerminal = async (
    reviewSessionId: string,
    terminal: Extract<
      ReviewVerbRequest,
      { name: "openNativeAgentTerminal" }
    >["args"],
  ): Promise<void> => {
    const opened = await relay.dispatch(reviewSessionId, {
      name: "openNativeAgentTerminal",
      args: terminal,
    });
    if (!opened.ok) throw new Error(opened.error);
  };

  const cliPath = path.join(input.packageRoot, "dist", "cli.js");
  const discovery: ReviewDesktopDiscovery = {
    version: REVIEW_DESKTOP_DISCOVERY_VERSION,
    instanceId,
    url: urlForBoundPort(),
    appPid: input.appPid,
    serverPid: process.pid,
    token,
    startedAt: Date.now(),
    // A source-run dev server has no built CLI to advertise.
    ...(existsSync(cliPath)
      ? {
          cliPath,
          cliVersion: readProgressiveReviewPackageVersion(
            pathToFileURL(cliPath).href,
          ),
          ...(input.cliRuntimePath && existsSync(input.cliRuntimePath)
            ? { cliRuntimePath: input.cliRuntimePath }
            : {}),
        }
      : {}),
  };

  const app = new Hono<ReviewHonoEnv>();
  app.use("*", async (context, next) => {
    await next();
    applyCorsHeaders(context.req.raw, context.res);
  });
  app.options("*", (context) => corsPreflightResponse(context.req.raw));
  app.get("/health", () =>
    globalJson(200, {
      ok: true,
      instanceId,
      serverPid: process.pid,
      desktopAttached: relay.attached,
    }),
  );
  app.use("*", async (context, next) => {
    if (!isAuthorizedRequest(context.req.raw, token)) {
      return globalJson(401, { ok: false, error: "Unauthorized" });
    }
    await next();
  });
  app.post("/app/focus", async () => {
    const result = await relay.dispatch("review-desktop", {
      name: "focusWindow",
      args: {},
    });
    return globalJson(result.ok ? 200 : 409, result);
  });
  if (input.developmentModule) {
    app.all(input.developmentModule.routePath, (context) =>
      input.developmentModule!.fetch(context.req.raw),
    );
    app.all(`${input.developmentModule.routePath}/*`, (context) =>
      input.developmentModule!.fetch(context.req.raw),
    );
  }
  app.post("/telemetry/event", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({}));
      const payload =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      let flushBeforeOptOut = false;
      await captureSanitizedUiTelemetry(
        telemetry,
        context.req.raw,
        payload.name,
        payload.properties,
        (event) => {
          flushBeforeOptOut =
            event.event === "review_setting_changed" &&
            event.properties.setting === "telemetry_enabled" &&
            event.properties.enabled === false;
        },
        payload.error,
      );
      if (flushBeforeOptOut) await telemetry.flush(500);
    } catch (error) {
      console.error(error);
    }
    return globalJson(200, { ok: true });
  });
  app.get("/reviews", async () => {
    const { dismissedRetentionDays } = await readReviewPreferences();
    await reapDismissedReviews(dismissedRetentionDays);
    const listed = await listReviews();
    const reviews = await Promise.all(
      listed.reviews.map((stored) =>
        reviewDescriptor(stored, dismissedRetentionDays),
      ),
    );
    reviews.sort(
      (left, right) =>
        (right.lastPublishedAt ?? "").localeCompare(
          left.lastPublishedAt ?? "",
        ) || left.uuid.localeCompare(right.uuid),
    );
    return globalJson(200, { reviews, errors: listed.errors });
  });
  app.get("/sessions", () =>
    globalJson(200, {
      items: [...sessions.values()]
        .map((session) => session.descriptor)
        .sort((left, right) => right.startedAt - left.startedAt),
    }),
  );
  app.get("/tutorial/status", async () =>
    globalJson(200, await tutorial.status()),
  );
  app.post("/tutorial/prepare", async () => {
    const prepared = await withReviewLock(
      TUTORIAL_LIFECYCLE_LOCK_KEY,
      prepareTutorialLocked,
    );
    return globalJson(200, {
      ok: true,
      reviewUuid: prepared.review.review.uuid,
    });
  });
  // The tutorial descriptor is not in `GET /reviews`, so tooling and
  // integration checks fetch it here.
  app.get("/tutorial/review", async () => {
    const stored = await tutorial.find();
    if (!stored) {
      throw new ReviewServerError("Review not found.", 404);
    }
    return globalJson(200, await reviewDescriptor(stored));
  });
  app.post("/tutorial/open", async () => {
    return globalJson(
      200,
      await withReviewLock(TUTORIAL_LIFECYCLE_LOCK_KEY, openTutorialLocked),
    );
  });
  app.delete("/tutorial", async () => {
    await withReviewLock(TUTORIAL_LIFECYCLE_LOCK_KEY, deleteTutorialLocked);
    return globalJson(200, { ok: true });
  });
  app.post("/reviews/:uuid/open", async (context) => {
    const uuid = context.req.param("uuid");
    if (!UUID_PATTERN.test(uuid)) {
      throw new ReviewServerError("Review not found.", 404);
    }
    /* A background open keeps the canvas where it is: the Source tab opens
       sessions purely to root its file tree. Body-less requests (the CLI)
       stay foreground. */
    const openBody = (await context.req.json().catch(() => null)) as {
      background?: unknown;
      revision?: unknown;
      view?: unknown;
    } | null;
    const background = openBody?.background === true;
    const parsedView = reviewViewSchema.safeParse(openBody?.view);
    if (openBody?.view !== undefined && !parsedView.success) {
      throw new ReviewServerError(
        "Review view must be one of review, commits, diff, map, or trace.",
        400,
        "invalid_view",
      );
    }
    const view = parsedView.success ? parsedView.data : undefined;
    const review = await findReview(uuid);
    if (!review) {
      throw new ReviewServerError("Review not found.", 404);
    }
    const descriptor = await reviewDescriptor(review);
    const appSessionIdHeader = context.req.header(REVIEW_APP_SESSION_ID_HEADER);
    const appSessionId = isValidReviewAppSessionId(appSessionIdHeader)
      ? appSessionIdHeader
      : undefined;
    if (!descriptor.available) {
      throw new ReviewServerError(
        "The review worktree or document is unavailable.",
        409,
        "review_unavailable",
      );
    }
    if (!review.review.presentedDocumentRevision) {
      throw new ReviewServerError(
        "Review has no published revision yet. Run `review publish` first.",
        409,
        "review_unpublished",
      );
    }
    if (
      openBody?.revision !== undefined &&
      (typeof openBody.revision !== "string" ||
        !/^[0-9a-f]{40}$/.test(openBody.revision))
    ) {
      throw new ReviewServerError(
        "Review revision must be a 40-character hexadecimal commit ID.",
        400,
        "invalid_revision",
      );
    }
    const requestedRevision =
      typeof openBody?.revision === "string" &&
      openBody.revision !== review.review.presentedDocumentRevision
        ? openBody.revision
        : undefined;
    if (requestedRevision) {
      return openHistoricalReviewSession(
        review,
        requestedRevision,
        appSessionId,
        descriptor,
        view,
      );
    }
    const documentRevision = review.review.presentedDocumentRevision;
    /* Opening is what "viewed" means. Stamping here rather than on first
       render keeps the rule in one place and survives a canvas that never
       finishes loading. A dismissed review the reader reopens comes back. */
    const wasDismissed = Boolean(review.review.dismissedAt);
    const viewed = await restoreReview(await markReviewViewed(review));
    if (viewed.review !== review.review) {
      await broadcastReviewAttention(viewed, "viewed");
    }
    const homeReview: ReviewDescriptor = {
      ...descriptor,
      viewedAt: viewed.review.viewedAt ?? null,
      dismissedAt: viewed.review.dismissedAt ?? null,
      reapsAt: null,
    };
    if (wasDismissed) {
      await captureSanitizedUiTelemetry(
        telemetry,
        context.req.raw,
        "review_restored",
        { via: "open" },
      );
    }
    const existing = activeSessionForReview(review.review.uuid);
    if (existing) {
      existing.appSessionId ??= appSessionId;
      if (!background) {
        void relay.dispatch(existing.descriptor.sessionId, revealVerb(view));
      }
      return globalJson(200, {
        sessionId: existing.descriptor.sessionId,
        url: existing.descriptor.sessionUrl,
        session: existing.descriptor,
        review: homeReview,
      });
    }
    const documentBuildDir = await publishRuntime.materializePublishRevision({
      review: viewed,
      revision: documentRevision,
    });
    const presentedReview = await reviewWithPresentedDocumentPins(
      viewed,
      documentBuildDir,
    );
    const softwareMapRootPath = viewed.review.presentedSoftwareMapRevision
      ? await publishRuntime.materializePublishRevision({
          review: viewed,
          revision: viewed.review.presentedSoftwareMapRevision,
        })
      : undefined;
    const active = await registerSerialized({
      review: presentedReview,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      promoted: true,
      announce: true,
      focusCanvas: !background,
      view,
      background,
      appSessionId,
    });
    return globalJson(201, {
      sessionId: active.descriptor.sessionId,
      url: active.descriptor.sessionUrl,
      session: active.descriptor,
      review: homeReview,
    });
  });

  async function openHistoricalReviewSession(
    review: StoredReview,
    revision: string,
    appSessionId: string | undefined,
    homeReview: ReviewDescriptor,
    view: ReviewView | undefined,
  ): Promise<Response> {
    const existing = [...sessions.values()].find(
      (session) =>
        session.review.review.uuid === review.review.uuid &&
        session.historicalRevision === revision,
    );
    if (existing) {
      existing.appSessionId ??= appSessionId;
      void relay.dispatch(existing.descriptor.sessionId, revealVerb(view));
      return globalJson(200, {
        sessionId: existing.descriptor.sessionId,
        url: existing.descriptor.sessionUrl,
        session: existing.descriptor,
        review: homeReview,
      });
    }
    let documentBuildDir: string;
    try {
      documentBuildDir = await publishRuntime.materializePublishRevision({
        review,
        revision,
      });
    } catch {
      throw new ReviewServerError(
        "Review version not found.",
        404,
        "revision_not_found",
      );
    }
    const presentedReview = await reviewWithPresentedDocumentPins(
      review,
      documentBuildDir,
    );
    const presentedRecord = parseStoredReviewRecord(
      JSON.parse(
        await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
      ),
    );
    const softwareMapRootPath = presentedRecord.presentedSoftwareMapRevision
      ? await publishRuntime.materializePublishRevision({
          review,
          revision: presentedRecord.presentedSoftwareMapRevision,
        })
      : undefined;
    const active = await registerSerialized({
      review: presentedReview,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      promoted: false,
      historicalRevision: revision,
      announce: true,
      focusCanvas: true,
      view,
      appSessionId,
    });
    return globalJson(201, {
      sessionId: active.descriptor.sessionId,
      url: active.descriptor.sessionUrl,
      session: active.descriptor,
      review: homeReview,
    });
  }
  app.post("/reviews/:uuid/dismiss", async (context) => {
    const descriptor = await setReviewDismissed(
      context.req.param("uuid"),
      true,
    );
    await captureSanitizedUiTelemetry(
      telemetry,
      context.req.raw,
      "review_dismissed",
      { via: "home" },
    );
    return globalJson(200, descriptor);
  });
  app.post("/reviews/:uuid/restore", async (context) => {
    const descriptor = await setReviewDismissed(
      context.req.param("uuid"),
      false,
    );
    await captureSanitizedUiTelemetry(
      telemetry,
      context.req.raw,
      "review_restored",
      { via: "home" },
    );
    return globalJson(200, descriptor);
  });
  app.get("/preferences", async () =>
    globalJson(200, await readReviewPreferences()),
  );
  app.put("/preferences", async (context) => {
    const body = (await readBoundedRequestJson(context.req.raw)) as {
      dismissedRetentionDays?: unknown;
    };
    const value = body.dismissedRetentionDays;
    if (value !== null && typeof value !== "number") {
      throw new ReviewServerError(
        "dismissedRetentionDays must be a number or null.",
        400,
      );
    }
    const saved = await writeReviewPreferences({
      dismissedRetentionDays: value,
    });
    broadcastGlobal({ event: "preferences-changed", preferences: saved });
    return globalJson(200, saved);
  });
  app.delete("/reviews/:uuid", async (context) => {
    const uuid = context.req.param("uuid");
    if (!UUID_PATTERN.test(uuid)) {
      throw new ReviewServerError("Review not found.", 404);
    }
    const referencesTutorial =
      preparedTutorial?.review.review.uuid === uuid ||
      tutorialAuthoringStates.has(uuid) ||
      (await tutorial.referencesReview(uuid));
    if (referencesTutorial) {
      await withReviewLock(TUTORIAL_LIFECYCLE_LOCK_KEY, async () => {
        const stillReferencesTutorial =
          preparedTutorial?.review.review.uuid === uuid ||
          tutorialAuthoringStates.has(uuid) ||
          (await tutorial.referencesReview(uuid));
        if (stillReferencesTutorial) {
          await deleteTutorialLocked();
          if (existsSync(path.join(reviewsHomeDir(), uuid))) {
            await deleteReviewByUuid(uuid);
          }
          return;
        }
        await deleteReviewByUuid(uuid);
      });
    } else {
      await deleteReviewByUuid(uuid);
    }
    await telemetry.captureReviewDeleted();
    return globalJson(200, { ok: true });
  });
  app.post("/info", async (context) =>
    globalJson(
      200,
      await resolveReviewInfo(
        parseInfoRequest(await readBoundedRequestJson(context.req.raw)),
      ),
    ),
  );
  app.get("/install/status", async () =>
    globalJson(
      200,
      await resolveCliInstallStatus({ packageRoot: input.packageRoot }),
    ),
  );
  app.post("/install/apply", async (context) => {
    const request = parseReviewCliInstallApplyRequest(
      await readBoundedRequestJson(context.req.raw),
    );
    const result = await applyCliInstall({
      packageRoot: input.packageRoot,
      targets: request.targets,
      ...(request.shim !== undefined ? { shim: request.shim } : {}),
      ...(request.fff ? { fff: true } : {}),
      ...(request.trace !== undefined ? { trace: request.trace } : {}),
      ...(discovery.cliPath ? { cliPath: discovery.cliPath } : {}),
      ...(discovery.cliRuntimePath
        ? { cliRuntimePath: discovery.cliRuntimePath }
        : {}),
    });
    return globalJson(result.code === 0 ? 200 : 500, {
      ok: result.code === 0,
      output: result.output,
      ...(result.shimPath ? { shimPath: result.shimPath } : {}),
    });
  });
  app.post("/install/remove", async (context) => {
    const request = parseReviewCliInstallApplyRequest(
      await readBoundedRequestJson(context.req.raw),
    );
    const result = await removeCliInstall({
      targets: request.targets,
      ...(request.shim ? { shim: true } : {}),
      ...(request.fff ? { fff: true } : {}),
      ...(request.trace ? { trace: true } : {}),
    });
    return globalJson(200, { ok: true, output: result.output });
  });
  app.post("/install/decline", async () => {
    await declineCliInstall();
    return globalJson(200, { ok: true });
  });
  app.post("/install/skip", async () => {
    await skipCliInstall();
    return globalJson(200, { ok: true });
  });
  app.post("/install/reset", async () => {
    await resetCliInstall();
    return globalJson(200, { ok: true });
  });
  app.post("/publish-ready", async (context) => {
    try {
      const request = parseReviewPublishReadyRequest(
        await readBoundedRequestJson(context.req.raw),
      );
      let review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      const agent = request.agent;
      if (agent) {
        const found = review;
        review = await withReviewLock(request.reviewUuid, () =>
          touchReviewAgentSession(
            found,
            authoringSessionKey(agent),
            "publisher",
          ),
        );
      }
      return globalJson(
        201,
        await mountPublishedDocument(review, request.revision, request.view),
      );
    } catch (error) {
      await telemetry.capturePublishGateRejected({ gate: "publish_ready" });
      throw error;
    }
  });
  app.post("/map-publish-ready", async (context) => {
    try {
      const request = parseReviewPublishReadyRequest(
        await readBoundedRequestJson(context.req.raw),
      );
      let review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      const agent = request.agent;
      if (agent) {
        const found = review;
        review = await withReviewLock(request.reviewUuid, () =>
          touchReviewAgentSession(
            found,
            authoringSessionKey(agent),
            "publisher",
          ),
        );
      }
      return globalJson(
        201,
        await mountPublishedSoftwareMap(review, request.revision),
      );
    } catch (error) {
      await telemetry.capturePublishGateRejected({
        gate: "map_publish_ready",
      });
      throw error;
    }
  });
  app.get("/events", (context) => openGlobalEvents(context));
  app.get("/control", (context) => openControlEvents(context));
  app.post("/control/result", async (context) => {
    const accepted = relay.acceptResult(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(accepted ? 200 : 404, { ok: accepted });
  });
  app.get("/sessions/:sessionId/lifecycle", (context) =>
    openLifecycleEvents(
      context,
      context.req.param("sessionId"),
      new URL(context.req.url),
    ),
  );
  app.post("/sessions/:sessionId/verb", async (context) => {
    const active = sessions.get(context.req.param("sessionId"));
    if (!active) throw new ReviewServerError("Session not found.", 404);
    const result = await relay.dispatch(
      active.descriptor.sessionId,
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(result.ok ? 200 : 409, result);
  });
  app.delete("/sessions/:sessionId", async (context) => {
    const active = sessions.get(context.req.param("sessionId"));
    if (!active) throw new ReviewServerError("Session not found.", 404);
    const terminal =
      active.promoted && context.req.query("terminal") !== "false";
    await closeSession(active, "closed", terminal);
    return globalJson(200, { ok: true });
  });
  app.all("/sessions/:sessionId", (context) =>
    handleSessionRequest(context, ""),
  );
  app.all("/sessions/:sessionId/*", (context) =>
    handleSessionRequest(
      context,
      sessionRouteSuffix(new URL(context.req.url).pathname),
    ),
  );
  app.notFound(() => globalJson(404, { ok: false, error: "Not found." }));
  app.onError((error) => {
    const serverError =
      error instanceof ReviewServerError ||
      error instanceof ReviewOpenThreadsError
        ? error
        : undefined;
    return globalJson(serverError?.statusCode ?? httpJsonStatus(error), {
      ok: false,
      ...(serverError?.code ? { code: serverError.code } : {}),
      error: toError(error).message,
    });
  });

  const httpServer = createServer(createNodeRequestListener(app));

  function handleSessionRequest(
    context: Context<ReviewHonoEnv>,
    suffix: string,
  ): Promise<Response> {
    const sessionId = context.req.param("sessionId");
    if (!sessionId) throw new ReviewServerError("Session not found.", 404);
    const active = sessions.get(sessionId);
    if (!active) throw new ReviewServerError("Session not found.", 404);
    return dispatchToSession(
      active.handler,
      context.req.raw,
      suffix,
      context.env,
    );
  }

  function openControlEvents(context: Context<ReviewHonoEnv>): Response {
    let attached = false;
    const response = streamSSE(context, async (output) => {
      let finish!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const abort = new AbortController();
      let pending: Promise<void> = output
        .write(": attached\n\n")
        .then(() => undefined);
      const writer = {
        signal: abort.signal,
        write(frame: string) {
          pending = pending.then(async () => {
            await output.write(frame);
          });
        },
        close() {
          finish();
          void output.close();
        },
      };
      output.onAbort(() => {
        abort.abort();
        finish();
      });
      attached = relay.attach(writer);
      if (!attached) {
        finish();
        return;
      }
      try {
        await disconnected;
        await pending;
      } finally {
        abort.abort();
      }
    });
    if (!attached) {
      void response.body?.cancel();
      return globalJson(409, {
        ok: false,
        error: "A Review Desktop control client is already attached.",
      });
    }
    response.headers.set("cache-control", "no-cache, no-transform");
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  }

  // The CLI already validated, bundled, and sealed the revision; the server
  // materializes it, has the app mount it off-screen, and promotes it only
  // when that mount is clean.
  async function mountPublishedDocument(
    review: StoredReview,
    revision: string,
    view?: ReviewView,
  ): Promise<{
    ok: true;
    revision: string;
    sessionId: string;
    url: string;
    focusWarning?: string;
  }> {
    const sourceCommit = review.review.sourceCommit;
    const sourceBranch = review.review.sourceIdentity?.name;
    if (!sourceCommit || !sourceBranch) {
      throw new ReviewServerError(
        `Review ${review.review.uuid} is not bound to a source commit.`,
        409,
        "review_unbound",
      );
    }
    const source = { sourceCommit, sourceBranch };
    const buildDir = await publishRuntime.materializePublishRevision({
      review,
      revision,
    });
    const softwareMapRootPath = review.review.presentedSoftwareMapRevision
      ? await publishRuntime.materializePublishRevision({
          review,
          revision: review.review.presentedSoftwareMapRevision,
        })
      : undefined;
    const documentPath = path.join(buildDir, "review.mdx");
    const successor = await registerSerialized({
      review,
      documentPath,
      softwareMapRootPath,
      revision,
      source,
      promoted: false,
    });
    try {
      // The app mounts the unpromoted session off-screen first. A failed
      // mount fails the publish before promotion, so the reviewer keeps the
      // last good revision on screen.
      const validation = await relay.dispatch(successor.descriptor.sessionId, {
        name: "validateCanvasMount",
        args: {},
      });
      if (!validation.ok) {
        throw new ReviewServerError(
          `Review document failed to mount: ${validation.error ?? "unknown error"}`,
          422,
          "mount_validation_failed",
        );
      }
      await withReviewLock(review.review.uuid, async () => {
        if (
          successor.closing ||
          sessions.get(successor.descriptor.sessionId) !== successor ||
          !successor.revision ||
          !successor.source
        ) {
          throw new ReviewServerError("Review session is unavailable.", 404);
        }
        const latest = await findReview(review.review.uuid);
        if (!latest) throw new ReviewServerError("Review not found.", 404);
        rejectTerminalPublication(latest);
        rejectConcurrentPublication(latest, review);
        requireClosedThreadsForRepublish(latest);
        successor.review = await promoteReview(
          latest,
          successor.revision,
          successor.source,
          await reviewTitleFromDocument(documentPath),
        );
        successor.promoted = true;
        await startSessionTelemetry(successor);
        await clearReopenPending(successor.review.review.worktreePath);
        broadcastGlobal({
          event: "review-status-changed",
          uuid: successor.review.review.uuid,
          status: "awaiting-review",
        });
        broadcastGlobal({
          event: "session-registered",
          session: successor.descriptor,
          review: await reviewDescriptor(
            successor.review,
            (await readReviewPreferences()).dismissedRetentionDays,
          ),
        });
        const replaced = [...sessions.values()].filter(
          (session) =>
            session !== successor &&
            session.review.review.uuid === successor.review.review.uuid &&
            session.promoted,
        );
        await Promise.all(
          replaced.map((session) => closeSession(session, "replaced", false)),
        );
      });
    } finally {
      if (!successor.promoted) {
        await closeSession(successor, "closed", false);
      }
    }
    // Promotion already happened: from here on nothing can fail the publish.
    // A focus failure is a warning — the promoted revision is live either
    // way — and a prune failure is ignored.
    const focus = await relay.dispatch(
      successor.descriptor.sessionId,
      revealVerb(view),
    );
    await pruneReviewBuilds(review.dir, [
      revision,
      ...(successor.review.review.presentedSoftwareMapRevision
        ? [successor.review.review.presentedSoftwareMapRevision]
        : []),
    ]).catch(() => undefined);
    return {
      ok: true,
      revision,
      sessionId: successor.descriptor.sessionId,
      url: successor.descriptor.sessionUrl,
      ...(focus.ok ? {} : { focusWarning: focus.error }),
    };
  }

  async function mountPublishedSoftwareMap(
    review: StoredReview,
    revision: string,
  ): Promise<{ ok: true; revision: string }> {
    const documentRevision = review.review.presentedDocumentRevision;
    if (!documentRevision) {
      throw new ReviewServerError(
        "The Review document is not published.",
        409,
        "review_unpublished",
      );
    }
    const [documentBuildDir, softwareMapRootPath] = await Promise.all([
      publishRuntime.materializePublishRevision({
        review,
        revision: documentRevision,
      }),
      publishRuntime.materializePublishRevision({ review, revision }),
    ]);
    const mapBundle = await readReviewSoftwareMapBundle(softwareMapRootPath);
    if (!mapBundle) {
      throw new ReviewServerError(
        "The published software map bundle is missing.",
        422,
        "map_bundle_missing",
      );
    }
    const presentedReview = await reviewWithPresentedDocumentPins(
      review,
      documentBuildDir,
    );
    if (
      mapBundle.headCommit !== presentedReview.review.sourceCommit ||
      mapBundle.baseCommit !== presentedReview.review.baseCommit
    ) {
      throw new ReviewServerError(
        "The software map pins do not match the published Review document.",
        422,
        "map_pins_mismatch",
      );
    }
    const sourceCommit = presentedReview.review.sourceCommit;
    const sourceBranch = presentedReview.review.sourceIdentity?.name;
    if (!sourceCommit || !sourceBranch) {
      throw new ReviewServerError(
        "The published Review document has no source pins.",
        409,
        "review_unbound",
      );
    }
    const successor = await registerSerialized({
      review: presentedReview,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      revision: documentRevision,
      source: { sourceCommit, sourceBranch },
      promoted: false,
    });
    try {
      const validation = await relay.dispatch(successor.descriptor.sessionId, {
        name: "validateCanvasMount",
        args: {},
      });
      if (!validation.ok) {
        throw new ReviewServerError(
          `Software map failed to load: ${validation.error ?? "unknown error"}`,
          422,
          "map_validation_failed",
        );
      }
      await withReviewLock(review.review.uuid, async () => {
        const latest = await findReview(review.review.uuid);
        if (!latest) throw new ReviewServerError("Review not found.", 404);
        rejectTerminalPublication(latest);
        rejectConcurrentPublication(latest, review);
        successor.review = await promoteSoftwareMap(latest, revision);
        successor.promoted = true;
        await startSessionTelemetry(successor);
        broadcastGlobal({
          event: "session-registered",
          session: successor.descriptor,
          review: await reviewDescriptor(
            successor.review,
            (await readReviewPreferences()).dismissedRetentionDays,
          ),
        });
        const replaced = [...sessions.values()].filter(
          (session) =>
            session !== successor &&
            session.review.review.uuid === successor.review.review.uuid &&
            session.promoted,
        );
        await Promise.all(
          replaced.map((session) => closeSession(session, "replaced", false)),
        );
      });
    } finally {
      if (!successor.promoted) {
        await closeSession(successor, "closed", false);
      }
    }
    void relay.dispatch(successor.descriptor.sessionId, {
      name: "focusCanvas",
      args: {},
    });
    await pruneReviewBuilds(review.dir, [documentRevision, revision]).catch(
      () => undefined,
    );
    return { ok: true, revision };
  }

  /* Match by path rather than tutorial.find(): an invalid stamp or repo must
     not leave a session serving files that cleanup is about to delete. */
  async function closeTutorialSessions(): Promise<void> {
    const tutorialRoot = path.resolve(devReviewHome(), "tutorial");
    const open = [...sessions.values()].filter((session) => {
      if (session.tutorialPreparation) return true;
      const relative = path.relative(
        tutorialRoot,
        path.resolve(session.review.review.worktreePath),
      );
      return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    });
    await Promise.all(
      open.map((session) => closeSession(session, "closed", false)),
    );
  }

  async function prepareTutorialLocked(): Promise<PreparedTutorial> {
    const tutorialAgent = await tutorialAgentResolver();
    if (!tutorialAgent) {
      throw new ReviewServerError(
        "Install Claude Code, Codex, or Pi before opening the tutorial.",
        409,
        "tutorial_agent_unavailable",
      );
    }
    const cached = await validPreparedTutorial(tutorialAgent);
    if (cached) return cached;
    const prepared = await prepareTutorialLocally(tutorialAgent);
    preparedTutorial = prepared;
    return prepared;
  }

  async function validPreparedTutorial(
    tutorialAgent: ReviewAgentHarness,
  ): Promise<PreparedTutorial | null> {
    const cached = preparedTutorial;
    if (!cached) return null;
    const current = await withReviewLock(cached.review.review.uuid, () =>
      tutorial.find().catch(() => null),
    );
    const currentReview = current?.review;
    const cachedReview = cached.review.review;
    const documentExists = existsSync(cached.documentPath);
    const softwareMapExists = existsSync(cached.softwareMapRootPath);
    const pathsExist =
      documentExists &&
      softwareMapExists &&
      existsSync(cached.checkoutRoots.baseRootPath) &&
      existsSync(cached.checkoutRoots.headRootPath);
    if (
      !currentReview ||
      currentReview.uuid !== cachedReview.uuid ||
      currentReview.presentedDocumentRevision !==
        cachedReview.presentedDocumentRevision ||
      currentReview.presentedSoftwareMapRevision !==
        cachedReview.presentedSoftwareMapRevision ||
      cached.harness !== tutorialAgent ||
      !pathsExist
    ) {
      preparedTutorial = null;
      await abortTutorialAuthoringState(cachedReview.uuid);
      await closeTutorialSessions();
      if (!documentExists) {
        await rm(path.dirname(cached.documentPath), {
          recursive: true,
          force: true,
        });
      } else if (!softwareMapExists) {
        await rm(cached.softwareMapRootPath, { recursive: true, force: true });
      }
      return null;
    }
    cached.review = current;
    return cached;
  }

  /* The Welcome page invokes only this local preparation path: materialize the
     shipped Review and warm both managed Git checkouts. No agent command or
     model turn starts until Open tutorial is clicked. */
  async function prepareTutorialLocally(
    tutorialAgent: ReviewAgentHarness,
  ): Promise<PreparedTutorial> {
    const startedAt = Date.now();
    const review = await tutorial.prepare(tutorialAgent, {
      beforeReset: async () => {
        preparedTutorial = null;
        await abortTutorialAuthoringStates();
        await closeTutorialSessions();
      },
    });
    const documentRevision = review.review.presentedDocumentRevision;
    const softwareMapRevision = review.review.presentedSoftwareMapRevision;
    if (!documentRevision || !softwareMapRevision) {
      throw new ReviewServerError(
        "Tutorial Review has no published revision.",
        409,
        "review_unpublished",
      );
    }
    const documentBuildDir = await publishRuntime.materializePublishRevision({
      review,
      revision: documentRevision,
    });
    const softwareMapRootPath = await publishRuntime.materializePublishRevision(
      {
        review,
        revision: softwareMapRevision,
      },
    );
    const presentedReview = await reviewWithPresentedDocumentPins(
      review,
      documentBuildDir,
    );
    const checkoutRoots = await ensureReviewCheckouts(presentedReview);
    console.info(
      `[Review tutorial] local preparation completed in ${Date.now() - startedAt}ms.`,
    );
    return {
      review: presentedReview,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      checkoutRoots,
      harness: tutorialAgent,
    };
  }

  /* Open mounts the already-prepared artifacts immediately, then starts one
     shared native source-session handoff in the background. */
  async function openTutorialLocked(): Promise<ReviewTutorialOpenResponse> {
    const prepared = await prepareTutorialLocked();
    let existing = activeSessionForReview(prepared.review.review.uuid);
    if (
      existing &&
      (existing.tutorialPreparation !== prepared ||
        (!parseAuthoringSessionKey(existing.review.review.sourceSession) &&
          !existing.resolveQuestionSourceSession))
    ) {
      await closeSession(existing, "replaced", false);
      existing = undefined;
    }
    if (existing) {
      void relay.dispatch(existing.descriptor.sessionId, {
        name: "focusCanvas",
        args: {},
      });
    }
    const resolveQuestionSourceSession = (signal?: AbortSignal) =>
      ensureTutorialAuthoringSession(prepared, true, signal);
    const session =
      existing ??
      (await registerSerialized({
        review: prepared.review,
        documentPath: prepared.documentPath,
        softwareMapRootPath: prepared.softwareMapRootPath,
        checkoutRoots: prepared.checkoutRoots,
        tutorialPreparation: prepared,
        resolveQuestionSourceSession,
        promoted: true,
        focusCanvas: true,
      }));
    void ensureTutorialAuthoringSession(prepared, false);
    return {
      reviewUuid: session.review.review.uuid,
      sessionId: session.descriptor.sessionId,
      url: session.descriptor.sessionUrl,
      review: await reviewDescriptor(session.review),
      session: session.descriptor,
    };
  }

  async function ensureTutorialAuthoringSession(
    prepared: PreparedTutorial,
    allowRetry: boolean,
    signal?: AbortSignal,
  ): Promise<SessionRef | undefined> {
    if (signal?.aborted) return undefined;
    const persisted = parseAuthoringSessionKey(
      prepared.review.review.sourceSession,
    );
    if (persisted) return persisted;
    const uuid = prepared.review.review.uuid;
    let state = tutorialAuthoringStates.get(uuid);
    if (!state) {
      state = { attempts: 0 };
      tutorialAuthoringStates.set(uuid, state);
    }
    while (true) {
      if (signal?.aborted || tutorialAuthoringStates.get(uuid) !== state) {
        return undefined;
      }
      if (state.session) return state.session;
      if (state.operation) {
        const session = await waitForTutorialAuthoringOperation(
          state.operation.promise,
          signal,
        );
        if (signal?.aborted || tutorialAuthoringStates.get(uuid) !== state) {
          return undefined;
        }
        if (session) return session;
        continue;
      }
      if (state.attempts > 0 && (!allowRetry || state.attempts >= 2)) {
        return undefined;
      }
      if (signal?.aborted || tutorialAuthoringStates.get(uuid) !== state) {
        return undefined;
      }
      const operation = startTutorialAuthoringAttempt(prepared, state);
      state.operation = operation;
    }
  }

  function startTutorialAuthoringAttempt(
    prepared: PreparedTutorial,
    state: TutorialAuthoringState,
  ): NonNullable<TutorialAuthoringState["operation"]> {
    const controller = new AbortController();
    const attempt = ++state.attempts;
    const startedAt = Date.now();
    const operation: NonNullable<TutorialAuthoringState["operation"]> = {
      controller,
      promise: Promise.resolve(undefined),
    };
    const isCurrent = () =>
      !controller.signal.aborted &&
      tutorialAuthoringStates.get(prepared.review.review.uuid) === state;
    operation.promise = (async (): Promise<SessionRef | undefined> => {
      console.info(
        `[Review tutorial] source-session handoff attempt ${attempt} started (${prepared.harness}).`,
      );
      try {
        const session = await tutorialAuthoringSessionFactory({
          harness: prepared.harness,
          rootPath: prepared.checkoutRoots.headRootPath,
          signal: controller.signal,
        });
        if (!isCurrent()) return undefined;
        const updated = await withReviewLock(
          prepared.review.review.uuid,
          async () => {
            if (!isCurrent()) return undefined;
            const latest = await findReview(prepared.review.review.uuid);
            if (!latest) return undefined;
            const bound = await tutorialAuthorSessionBinder(latest, session);
            prepared.review = bound;
            for (const active of sessions.values()) {
              if (active.review.review.uuid === bound.review.uuid) {
                active.review = bound;
              }
            }
            return bound;
          },
        );
        if (!updated || !isCurrent()) return undefined;
        state.session = session;
        console.info(
          `[Review tutorial] source-session handoff completed in ${Date.now() - startedAt}ms.`,
        );
        return session;
      } catch {
        const outcome = controller.signal.aborted ? "canceled" : "failed";
        const fallback =
          attempt < 2
            ? "Ask now will retry once before falling back."
            : "Ask now will start a fresh session.";
        console.warn(
          `[Review tutorial] source-session handoff ${outcome} after ${Date.now() - startedAt}ms; ${fallback}`,
        );
        return undefined;
      } finally {
        if (
          tutorialAuthoringStates.get(prepared.review.review.uuid) === state &&
          state.operation === operation
        ) {
          state.operation = undefined;
        }
      }
    })();
    return operation;
  }

  async function abortTutorialAuthoringState(uuid: string): Promise<void> {
    const state = tutorialAuthoringStates.get(uuid);
    if (!state) return;
    tutorialAuthoringStates.delete(uuid);
    state.operation?.controller.abort();
    if (state.operation) await Promise.allSettled([state.operation.promise]);
  }

  async function waitForTutorialAuthoringOperation(
    operation: Promise<SessionRef | undefined>,
    signal?: AbortSignal,
  ): Promise<SessionRef | undefined> {
    if (!signal) return operation;
    if (signal.aborted) return undefined;
    return new Promise((resolve) => {
      const aborted = () => resolve(undefined);
      signal.addEventListener("abort", aborted, { once: true });
      void operation
        .then(resolve, () => resolve(undefined))
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    });
  }

  async function abortTutorialAuthoringStates(): Promise<void> {
    await Promise.allSettled(
      [...tutorialAuthoringStates.keys()].map((uuid) =>
        abortTutorialAuthoringState(uuid),
      ),
    );
  }

  async function deleteTutorialLocked(): Promise<void> {
    preparedTutorial = null;
    await abortTutorialAuthoringStates();
    await closeTutorialSessions();
    await tutorial.cleanup();
  }

  async function deleteReviewByUuid(uuid: string): Promise<void> {
    // Deletion bypasses findReview on purpose: a review with a corrupt
    // review.json must still be deletable.
    await withReviewLock(uuid, async () => {
      const dir = path.join(reviewsHomeDir(), uuid);
      if (!existsSync(dir)) {
        throw new ReviewServerError("Review not found.", 404);
      }
      const stored = await findReview(uuid).catch(() => null);
      if (stored) {
        await deleteStoredReviewUnlocked(stored);
        return;
      }
      const open = [...sessions.values()].filter(
        (session) => session.review.review.uuid === uuid,
      );
      await Promise.all(
        open.map((session) => closeSession(session, "closed", false)),
      );
      await rm(dir, { recursive: true, force: true });
      const worktreePath = open[0]?.review.review.worktreePath;
      if (worktreePath) {
        await clearReopenPending(worktreePath).catch(() => undefined);
      }
      broadcastGlobal({ event: "review-deleted", uuid });
    });
  }

  async function deleteStoredReview(review: StoredReview): Promise<void> {
    await withReviewLock(review.review.uuid, () =>
      deleteStoredReviewUnlocked(review),
    );
  }

  async function deleteStoredReviewUnlocked(
    review: StoredReview,
  ): Promise<void> {
    const open = [...sessions.values()].filter(
      (session) => session.review.review.uuid === review.review.uuid,
    );
    await Promise.all(
      open.map((session) => closeSession(session, "closed", false)),
    );
    await removeReviewManagedCheckouts({
      rootPath: review.review.worktreePath,
      reviewUuid: review.review.uuid,
    });
    await rm(review.dir, { recursive: true, force: true });
    await clearReopenPending(review.review.worktreePath).catch(() => undefined);
    broadcastGlobal({ event: "review-deleted", uuid: review.review.uuid });
  }

  async function registerSerialized(
    registration: RegisterSessionInput,
  ): Promise<ActiveReviewSession> {
    return withReviewLock(registration.review.review.uuid, () =>
      registerSession(registration),
    );
  }

  async function ensureReviewCheckouts(
    review: StoredReview,
    sourceCommit = review.review.sourceCommit,
  ): Promise<ReviewCheckoutRoots> {
    if (!sourceCommit) {
      throw new ReviewServerError(
        `Review ${review.review.uuid} is not bound to a source commit.`,
        409,
        "review_unbound",
      );
    }
    const baseRootPath = await ensureReviewPinnedCheckout({
      rootPath: review.review.worktreePath,
      ref: review.review.baseCommit,
      reviewUuid: review.review.uuid,
      role: "base",
    });
    const headRootPath = await ensureReviewPinnedCheckout({
      rootPath: review.review.worktreePath,
      ref: sourceCommit,
      reviewUuid: review.review.uuid,
      role: "head",
    });
    if (!baseRootPath || !headRootPath) {
      throw new ReviewServerError(
        `Review ${review.review.uuid} cannot create its managed checkout.`,
        409,
        "review_checkout_unavailable",
      );
    }
    return { baseRootPath, headRootPath };
  }

  async function registerSession(
    registration: RegisterSessionInput,
  ): Promise<ActiveReviewSession> {
    if (closing) {
      throw new ReviewServerError(
        "Review Desktop is closing.",
        409,
        "server_closing",
      );
    }
    if (registration.promoted) {
      const existing = [...sessions.values()].find(
        (session) =>
          session.review.review.uuid === registration.review.review.uuid &&
          session.promoted,
      );
      if (existing) return existing;
    }
    if (registration.historicalRevision) {
      const existing = [...sessions.values()].find(
        (session) =>
          session.review.review.uuid === registration.review.review.uuid &&
          session.historicalRevision === registration.historicalRevision,
      );
      if (existing) return existing;
    }
    if (sessions.size >= capacity) {
      throw new ReviewServerError(
        `Review Desktop supports at most ${capacity} sessions.`,
        409,
        "session_capacity",
      );
    }

    const sessionId = crypto.randomUUID();
    const sessionUrl = `${urlForBoundPort()}/sessions/${encodeURIComponent(sessionId)}`;
    const descriptor: ReviewSessionDescriptor = {
      sessionId,
      sessionUrl,
      reviewUuid: registration.review.review.uuid,
      routePath: "/",
      startedAt: Date.now(),
      ...(registration.historicalRevision
        ? { historicalRevision: registration.historicalRevision }
        : {}),
    };
    const sourceCommit =
      registration.source?.sourceCommit ??
      registration.review.review.sourceCommit;
    const { baseRootPath, headRootPath } =
      registration.checkoutRoots ??
      (await ensureReviewCheckouts(registration.review, sourceCommit));
    const sessionWire = sessionWireFor(
      registration.review,
      descriptor,
      boundPort,
      registration.documentPath,
      registration.source,
      baseRootPath,
      headRootPath,
    );
    let active!: ActiveReviewSession;
    let handler: ReviewSessionHandler;
    try {
      handler = await sessionHandlerFactory({
        rootPath: registration.review.review.worktreePath,
        reviewRootPath: registration.review.dir,
        toolingRoot: input.toolingRoot,
        reviewPath: registration.documentPath,
        softwareMapRootPath: registration.softwareMapRootPath,
        stateReviewPath: path.join(registration.review.dir, "review.mdx"),
        routePath: "/",
        token,
        sessionId,
        reviewUuid: registration.review.review.uuid,
        historicalRevision: registration.historicalRevision,
        listDocumentVersions: async () => {
          const latest = await findReview(registration.review.review.uuid);
          return latest ? listReviewDocumentVersions(latest) : [];
        },
        session: sessionWire,
        getReviewStatus: () => active.review.review.status,
        onSubmission: (submission) => onSubmission(active, submission),
        onReviewDismiss: () => onReviewDismiss(active),
        onReviewDataChange: () => {
          broadcastGlobal({
            event: "review-data-changed",
            uuid: registration.review.review.uuid,
            sessionId,
          });
        },
        onReviewThreadsCommit: (commit) => {
          broadcastGlobal({
            event: "review-threads-committed",
            uuid: registration.review.review.uuid,
            sessionId,
            commit,
            commentCount: countReviewComments(
              path.join(registration.review.dir, "review.mdx"),
            ),
          });
        },
        runReviewThreadMutation: (operation) =>
          withReviewLock(registration.review.review.uuid, async () =>
            operation(),
          ),
        reviewCliPath: discovery.cliPath,
        reviewCliRuntimePath: discovery.cliRuntimePath,
        openNativeAgentTerminal: (terminal) =>
          openNativeAgentTerminal(sessionId, terminal),
        resolveQuestionSourceSession: registration.resolveQuestionSourceSession,
        onQuestionAgentSession: (agent) =>
          withReviewLock(registration.review.review.uuid, async () => {
            const latest = await findReview(registration.review.review.uuid);
            if (!latest) throw new Error("Review not found.");
            active.review = await touchReviewAgentSession(
              latest,
              authoringSessionKey(agent),
              "question",
            );
          }),
        telemetry,
      });
    } catch (error) {
      lifecycle.append({
        event: "error",
        sessionId,
        error: toError(error).message,
      });
      throw error;
    }
    active = {
      descriptor,
      review: registration.review,
      documentPath: registration.documentPath,
      softwareMapRootPath: registration.softwareMapRootPath,
      revision: registration.revision,
      historicalRevision: registration.historicalRevision,
      source: registration.source,
      handler,
      promoted: registration.promoted,
      closing: false,
      telemetryStarted: false,
      telemetryEnded: false,
      appSessionId: registration.appSessionId,
      tutorialPreparation: registration.tutorialPreparation,
      resolveQuestionSourceSession: registration.resolveQuestionSourceSession,
    };
    sessions.set(sessionId, active);
    lifecycle.append({ event: "ready", sessionId });
    await startSessionTelemetry(active);
    if (registration.announce) {
      broadcastGlobal({
        event: "session-registered",
        session: descriptor,
        ...(registration.background ? { background: true } : {}),
      });
    }
    if (registration.focusCanvas) {
      void relay.dispatch(sessionId, revealVerb(registration.view));
    }
    return active;
  }

  async function onSubmission(
    active: ActiveReviewSession,
    submission: ReviewSubmissionEvent,
  ): Promise<void> {
    if (!active.promoted) {
      throw new Error("An unpromoted Review session cannot be submitted.");
    }
    await withReviewLock(active.review.review.uuid, async () => {
      const latest = await findReview(active.review.review.uuid);
      if (
        !latest ||
        active.closing ||
        sessions.get(active.descriptor.sessionId) !== active ||
        latest.review.status !== "awaiting-review"
      ) {
        throw new Error(
          "Only a review awaiting human action can be submitted.",
        );
      }
      active.review = latest;
      lifecycle.append({
        event: "submitted",
        sessionId: active.descriptor.sessionId,
        submission,
      });
      const status =
        submission.decision === "approve"
          ? "accepted"
          : "awaiting-agent-updates";
      active.review = await setReviewStatus(latest, status);
      if (submission.decision === "request-changes") {
        await markReopenPending(
          active.review.review.worktreePath,
          submission.createdAt,
        );
      }
      broadcastGlobal({
        event: "review-status-changed",
        uuid: active.review.review.uuid,
        status,
        decision: submission.decision,
      });
      await endSessionTelemetry(active, submission.decision);
      broadcastGlobal({
        event: "session-updated",
        session: active.descriptor,
      });
    });
  }

  /**
   * The reader is finished with this review. Dismissal stamps `dismissedAt` and
   * leaves the handoff status alone, so the review can be restored until the
   * reaper deletes it. It replaced the old reject, which was irreversible.
   */
  async function onReviewDismiss(active: ActiveReviewSession): Promise<void> {
    if (!active.promoted) {
      throw new Error("An unpromoted Review session cannot be dismissed.");
    }
    await withReviewLock(active.review.review.uuid, async () => {
      const latest = await findReview(active.review.review.uuid);
      if (
        !latest ||
        active.closing ||
        sessions.get(active.descriptor.sessionId) !== active ||
        latest.review.dismissedAt
      ) {
        return;
      }
      active.review = await dismissReview(latest);
      await clearReopenPending(active.review.review.worktreePath);
      await broadcastReviewAttention(active.review, "dismissed");
      broadcastGlobal({
        event: "session-updated",
        session: active.descriptor,
      });
      await endSessionTelemetry(active, "dismissed");
    });
  }

  /**
   * Dismissal and its undo. Only the stamp moves: the handoff `status` and the
   * review directory stay untouched, so the action stays reversible until the
   * reaper runs.
   */
  async function setReviewDismissed(
    uuid: string,
    dismissed: boolean,
  ): Promise<{
    ok: true;
    uuid: string;
    viewedAt: string | null;
    dismissedAt: string | null;
    reapsAt: string | null;
  }> {
    if (!UUID_PATTERN.test(uuid)) {
      throw new ReviewServerError("Review not found.", 404);
    }
    return withReviewLock(uuid, async () => {
      const stored = await findReview(uuid);
      if (!stored) throw new ReviewServerError("Review not found.", 404);
      const next = dismissed
        ? await dismissReview(stored)
        : await restoreReview(stored);
      const attention = dismissed
        ? "dismissed"
        : next.review.viewedAt
          ? "viewed"
          : "new";
      const patch = await reviewAttentionPatch(next);
      broadcastGlobal({
        event: "review-attention-changed",
        attention,
        ...patch,
      });
      return {
        ok: true as const,
        ...patch,
      };
    });
  }

  async function reviewAttentionPatch(review: StoredReview): Promise<{
    uuid: string;
    viewedAt: string | null;
    dismissedAt: string | null;
    reapsAt: string | null;
  }> {
    const { dismissedRetentionDays } = await readReviewPreferences();
    return {
      uuid: review.review.uuid,
      viewedAt: review.review.viewedAt ?? null,
      dismissedAt: review.review.dismissedAt ?? null,
      reapsAt: reviewReapsAt(review.review, dismissedRetentionDays),
    };
  }

  async function broadcastReviewAttention(
    review: StoredReview,
    attention: "new" | "viewed" | "dismissed",
  ): Promise<void> {
    broadcastGlobal({
      event: "review-attention-changed",
      attention,
      ...(await reviewAttentionPatch(review)),
    });
  }

  /**
   * Deletes the dismissed reviews whose retention window has closed. It runs on
   * every list, which is the only moment a stale review can become visible.
   * Deletion is permanent, so each one is logged.
   */
  async function reapDismissedReviews(
    retentionDays: number | null,
  ): Promise<void> {
    if (retentionDays === null) return;
    const listed = await listReviews().catch(() => null);
    if (!listed) return;
    for (const stored of selectReapableReviews(listed.reviews, retentionDays)) {
      const { uuid } = stored.review;
      // A review that is open must not vanish under the reader.
      if (activeSessionForReview(uuid)) continue;
      try {
        await withReviewLock(uuid, async () => {
          await rm(stored.dir, { recursive: true, force: true });
          await clearReopenPending(stored.review.worktreePath).catch(
            () => undefined,
          );
          broadcastGlobal({ event: "review-deleted", uuid });
        });
        console.info(
          `Reaped review ${uuid}: dismissed ${stored.review.dismissedAt}, retention ${retentionDays}d.`,
        );
        await telemetry.captureReviewReaped({ retentionDays });
      } catch (error) {
        console.error(`Could not reap review ${uuid}:`, error);
      }
    }
  }

  async function runReviewReaper(): Promise<void> {
    const { dismissedRetentionDays } = await readReviewPreferences();
    await reapDismissedReviews(dismissedRetentionDays);
  }

  async function endSessionTelemetry(
    active: ActiveReviewSession,
    outcome: "approve" | "request-changes" | "dismissed",
  ): Promise<void> {
    if (active.telemetryEnded || !active.telemetryStarted) return;
    active.telemetryEnded = true;
    await telemetry.captureSessionEnded({
      sourceKind: reviewSourceKind(active.review.review),
      agentKind: reviewAgentKind(active.review.review),
      outcome,
      durationMs: Date.now() - active.descriptor.startedAt,
      appSessionId: active.appSessionId,
      reviewUuid: active.review.review.uuid,
      presentationSessionId: active.descriptor.sessionId,
    });
  }

  async function startSessionTelemetry(
    active: ActiveReviewSession,
  ): Promise<void> {
    if (active.telemetryStarted || !active.promoted) return;
    active.telemetryStarted = true;
    await telemetry.captureSessionStarted({
      sourceKind: reviewSourceKind(active.review.review),
      agentKind: reviewAgentKind(active.review.review),
      appSessionId: active.appSessionId,
      reviewUuid: active.review.review.uuid,
      presentationSessionId: active.descriptor.sessionId,
    });
  }

  async function closeSession(
    active: ActiveReviewSession,
    reason: Extract<
      ReviewSessionLifecycleEvent,
      { event: "dismissed" }
    >["reason"],
    terminal: boolean,
  ): Promise<void> {
    if (active.closing) return;
    active.closing = true;
    sessions.delete(active.descriptor.sessionId);
    /* Closing the window ends the session, never the review. Dismissal is the
       only reader action that ends a review, and it has its own endpoint. This
       branch used to reject the review, which made closing a tab and finishing
       a review indistinguishable. */
    if (
      terminal &&
      active.promoted &&
      !lifecycle.terminal(active.descriptor.sessionId)
    ) {
      lifecycle.append({
        event: "dismissed",
        sessionId: active.descriptor.sessionId,
        reason,
      });
    }
    broadcastGlobal({
      event: "session-closed",
      sessionId: active.descriptor.sessionId,
      reason,
    });
    await active.handler.close();
  }

  function activeSessionForReview(
    reviewUuid: string,
  ): ActiveReviewSession | undefined {
    return [...sessions.values()].find(
      (session) =>
        session.review.review.uuid === reviewUuid && session.promoted,
    );
  }

  async function withReviewLock<T>(
    reviewUuid: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = reviewLocks.get(reviewUuid) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    reviewLocks.set(reviewUuid, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (reviewLocks.get(reviewUuid) === chain) reviewLocks.delete(reviewUuid);
    }
  }

  function openLifecycleEvents(
    context: Context<ReviewHonoEnv>,
    sessionId: string,
    requestUrl: URL,
  ): Response {
    const headerId = Number(context.req.header("last-event-id") ?? 0);
    const queryId = Number(requestUrl.searchParams.get("after") ?? 0);
    const afterId =
      Number.isSafeInteger(headerId) && headerId > 0
        ? headerId
        : Number.isSafeInteger(queryId) && queryId > 0
          ? queryId
          : 0;
    const response = streamSSE(context, async (output) => {
      let finish!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let pending: Promise<void> = output
        .write(": connected\n\n")
        .then(() => undefined);
      const write = (frame: string) => {
        pending = pending.then(async () => {
          await output.write(frame);
        });
      };
      for (const record of lifecycle.history(sessionId, afterId)) {
        write(lifecycleFrame(record));
      }
      const stop = lifecycle.subscribe(sessionId, (record) => {
        write(lifecycleFrame(record));
      });
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
      heartbeat.unref?.();
      output.onAbort(finish);
      try {
        await disconnected;
        await pending;
      } finally {
        clearInterval(heartbeat);
        stop();
      }
    });
    response.headers.set("cache-control", "no-cache, no-transform");
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  }

  function openGlobalEvents(context: Context<ReviewHonoEnv>): Response {
    const response = streamSSE(context, async (output) => {
      let finish!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let pending: Promise<void> = output
        .write(": connected\n\n")
        .then(() => undefined);
      const client: ReviewDesktopEventClient = {
        write(frame) {
          pending = pending.then(async () => {
            await output.write(frame);
          });
        },
        close() {
          finish();
          void output.close();
        },
      };
      output.onAbort(finish);
      globalClients.add(client);
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
        globalClients.delete(client);
      }
    });
    response.headers.set("cache-control", "no-cache, no-transform");
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  }

  function broadcastGlobal(event: ReviewDesktopGlobalEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of globalClients) client.write(frame);
  }

  return {
    discovery,
    get url() {
      return urlForBoundPort();
    },
    listen: async () => {
      boundPort = await listen(httpServer, input.port);
      discovery.url = urlForBoundPort();
      await writePrivateJsonAtomic(discoveryPath, discovery);
      void runReviewReaper().catch((error) =>
        console.error("Could not run Review cleanup:", error),
      );
      reviewReaper = setInterval(() => {
        void runReviewReaper().catch((error) =>
          console.error("Could not run Review cleanup:", error),
        );
      }, REVIEW_REAPER_INTERVAL_MS);
    },
    close: async () => {
      if (closing) return;
      closing = true;
      if (reviewReaper) clearInterval(reviewReaper);
      reviewReaper = undefined;
      await removeMatchingDiscovery(discoveryPath, discovery);
      await abortTutorialAuthoringStates();
      await Promise.all(
        [...sessions.values()].map((session) =>
          closeSession(session, "app-exit", false).catch(() => undefined),
        ),
      );
      relay.close();
      for (const client of globalClients) client.close();
      globalClients.clear();
      await closeHttpServer(httpServer);
      await input.developmentModule?.close();
      await telemetry.shutdown(1_500);
    },
  };
}

function reviewSourceKind(review: ReviewRecord): ProgressiveReviewSourceKind {
  if (review.pullRequestNumber) return "pull_request";
  if (review.sourceIdentity?.kind === "git-commit") return "git_commit";
  if (review.sourceIdentity?.kind === "jj-bookmark") return "jj_bookmark";
  if (review.sourceIdentity?.kind === "jj-change") return "jj_change";
  return "git_branch";
}

export function reviewAgentKind(
  review: ReviewRecord,
): ProgressiveReviewSessionAgent {
  const sessionKey =
    latestAgentSessionWithRole(review, "publisher") ??
    latestAgentSessionWithRole(review, "author") ??
    review.sourceSession;
  const freshHarness = parseFreshSourceSessionHarness(sessionKey);
  if (freshHarness === "codex") return "codex";
  if (freshHarness === "claude-code") return "claude";
  if (freshHarness === "pi") return "pi";
  const kind = sessionKey?.split(":", 1)[0];
  if (kind === "codex") return "codex";
  if (kind === "claude" || kind === "claude-code") return "claude";
  if (kind === "pi") return "pi";
  return "other";
}

function latestAgentSessionWithRole(
  review: ReviewRecord,
  role: "publisher" | "author",
): string | undefined {
  return Object.entries(review.agentSessions ?? {})
    .filter(([, attribution]) => attribution.roles.includes(role))
    .sort((left, right) =>
      right[1].lastSeenAt.localeCompare(left[1].lastSeenAt),
    )[0]?.[0];
}

function parseInfoRequest(value: unknown): RunReviewInfoInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpJsonError("Info request must be an object.", 400);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["cwd", "all", "reviewUuid"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new HttpJsonError("Info request has unexpected fields.", 400);
  }
  if (typeof input.cwd !== "string" || !input.cwd.trim()) {
    throw new HttpJsonError("Info request requires cwd.", 400);
  }
  if (input.all !== undefined && typeof input.all !== "boolean") {
    throw new HttpJsonError("Info all must be boolean.", 400);
  }
  if (
    input.reviewUuid !== undefined &&
    (typeof input.reviewUuid !== "string" || !input.reviewUuid.trim())
  ) {
    throw new HttpJsonError("Info reviewUuid must be a non-empty string.", 400);
  }
  if (input.all === true && input.reviewUuid !== undefined) {
    throw new HttpJsonError("Info all and reviewUuid cannot be combined.", 400);
  }
  return {
    cwd: input.cwd,
    ...(input.all ? { all: true } : {}),
    ...(typeof input.reviewUuid === "string"
      ? { reviewUuid: input.reviewUuid.trim() }
      : {}),
  };
}

async function pruneReviewBuilds(
  reviewDirPath: string,
  currentRevisions: readonly string[],
): Promise<void> {
  const buildsPath = path.join(reviewDirPath, ".build");
  let entries;
  try {
    entries = await readdir(buildsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const builds = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        modifiedAt: (await stat(path.join(buildsPath, entry.name))).mtimeMs,
      })),
  );
  const keep = new Set(currentRevisions);
  const previous = builds
    .filter((build) => !keep.has(build.name))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .at(0)?.name;
  await Promise.all(
    builds
      .filter((build) => !keep.has(build.name) && build.name !== previous)
      .map((build) =>
        rm(path.join(buildsPath, build.name), { recursive: true, force: true }),
      ),
  );
}

function sessionRouteSuffix(pathname: string): string {
  const match = pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  return match?.[2] ?? "";
}

async function dispatchToSession(
  handler: ReviewSessionHandler,
  request: Request,
  suffix: string,
  env: ReviewHonoEnv["Bindings"],
): Promise<Response> {
  if (suffix.startsWith("//")) {
    throw new ReviewServerError(
      "Session proxy paths cannot be protocol-relative.",
      400,
      "invalid_session_path",
    );
  }
  const requestUrl = new URL(request.url);
  const target = new URL(
    `${suffix || "/"}${requestUrl.search}`,
    "http://review-session.internal",
  );
  const headers = new Headers(request.headers);
  headers.delete("host");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const sessionRequest = new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    signal: request.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
  return handler.handle(sessionRequest, env);
}

function sessionWireFor(
  review: StoredReview,
  descriptor: ReviewSessionDescriptor,
  port: number,
  documentPath: string,
  source?: ActiveReviewSession["source"],
  baseRootPath?: string,
  headRootPath?: string,
): ReviewSessionWire {
  const headRef = source?.sourceCommit ?? review.review.sourceCommit;
  if (!headRef) {
    throw new ReviewServerError(
      `Review ${review.review.uuid} is not bound to a source commit.`,
      409,
      "review_unbound",
    );
  }
  const authoringAgent = parseAuthoringSessionKey(review.review.sourceSession);
  const freshQuestionHarness = parseFreshSourceSessionHarness(
    review.review.sourceSession,
  );
  return {
    sessionId: descriptor.sessionId,
    rootPath: review.review.worktreePath,
    baseRootPath,
    headRootPath,
    baseRef: review.review.baseCommit,
    headRef,
    pullRequestNumber: review.review.pullRequestNumber ?? undefined,
    pullRequestUrl: review.review.pullRequestUrl ?? undefined,
    routePath: descriptor.routePath,
    appUrl: descriptor.sessionUrl,
    appPort: port,
    serverUrl: new URL(descriptor.sessionUrl).origin,
    sessionUrl: descriptor.sessionUrl,
    storageDir: review.dir,
    reviewPath: documentPath,
    agent: authoringAgent,
    freshQuestionHarness,
    codexThreadId:
      authoringAgent?.harness === "codex"
        ? authoringAgent.sessionId
        : undefined,
    startedAt: descriptor.startedAt,
    ...(descriptor.historicalRevision
      ? { historicalRevision: descriptor.historicalRevision }
      : {}),
  };
}

async function promoteReview(
  stored: StoredReview,
  revision: string,
  source: { sourceCommit: string; sourceBranch: string },
  title: string | undefined,
): Promise<StoredReview> {
  const review: StoredReviewRecord = {
    ...stored.review,
    sourceCommit: source.sourceCommit,
    ...(title ? { title } : {}),
    status: "awaiting-review",
    presentedDocumentRevision: revision,
    lastPublishedAt: new Date().toISOString(),
    /* A publish is new work, so the review earns attention again and returns
       to Home as new. This also rescues a review that was dismissed and then
       updated rather than dropped. */
    viewedAt: null,
    dismissedAt: null,
  };
  await writePrivateJsonAtomic(path.join(stored.dir, "review.json"), review);
  return { ...stored, review };
}

async function promoteSoftwareMap(
  stored: StoredReview,
  revision: string,
): Promise<StoredReview> {
  const review: StoredReviewRecord = {
    ...stored.review,
    presentedSoftwareMapRevision: revision,
  };
  await writePrivateJsonAtomic(path.join(stored.dir, "review.json"), review);
  return { ...stored, review };
}

async function reviewWithPresentedDocumentPins(
  stored: StoredReview,
  documentBuildDir: string,
): Promise<StoredReview> {
  const presented = parseStoredReviewRecord(
    JSON.parse(
      await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
    ),
  );
  return {
    ...stored,
    review: {
      ...stored.review,
      baseRef: presented.baseRef,
      baseCommit: presented.baseCommit,
      sourceCommit: presented.sourceCommit,
      sourceIdentity: presented.sourceIdentity,
    },
  };
}

function rejectTerminalPublication(review: StoredReview): void {
  if (
    review.review.status === "accepted" ||
    review.review.status === "rejected"
  ) {
    throw new ReviewServerError(
      `Review ${review.review.uuid} is ${review.review.status}; publication pointers are frozen.`,
      409,
      "review_terminal",
    );
  }
}

function rejectConcurrentPublication(
  latest: StoredReview,
  startedFrom: StoredReview,
): void {
  if (
    latest.review.presentedDocumentRevision !==
      startedFrom.review.presentedDocumentRevision ||
    latest.review.presentedSoftwareMapRevision !==
      startedFrom.review.presentedSoftwareMapRevision
  ) {
    throw new ReviewServerError(
      "The presented Review artifacts changed during publication. Retry the command.",
      409,
      "review_publication_conflict",
    );
  }
}

async function setReviewStatus(
  stored: StoredReview,
  status: ReviewRecord["status"],
): Promise<StoredReview> {
  const review: StoredReviewRecord = { ...stored.review, status };
  await writePrivateJsonAtomic(path.join(stored.dir, "review.json"), review);
  return { ...stored, review };
}

function lifecycleFrame(record: {
  id: number;
  value: ReviewSessionLifecycleEvent;
}): string {
  return `id: ${record.id}\ndata: ${JSON.stringify(record.value)}\n\n`;
}

function httpJsonStatus(error: unknown): number {
  return error instanceof HttpJsonError ? error.statusCode : 400;
}

function globalJson(status: number, body: unknown): Response {
  return jsonResponse(body, status as ContentfulStatusCode, {
    cacheControl: "no-store",
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("The Review server did not bind a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function removeMatchingDiscovery(
  filePath: string,
  discovery: ReviewDesktopDiscovery,
): Promise<void> {
  try {
    const current = JSON.parse(await readFile(filePath, "utf8")) as {
      instanceId?: unknown;
      appPid?: unknown;
    };
    if (
      current.instanceId === discovery.instanceId &&
      current.appPid === discovery.appPid
    ) {
      await rm(filePath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
