import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type JsonObject,
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  ReviewAgentSessionRoleSchema,
  type ReviewCliInstallApplyResponse,
  type ReviewDescriptor,
  type ReviewDesktopDiscovery,
  type ReviewDesktopGlobalEvent,
  type ReviewRecord,
  type ReviewSessionDescriptor,
  type ReviewSessionWire,
  ReviewThreadsCommandSchema,
  type ReviewTutorialOpenResponse,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
  type ReviewView,
  isJsonObject,
  isObjectValue,
  jsonBoolean,
  jsonNumber,
  jsonProperty,
  jsonString,
  parseReviewCliInstallApplyRequest,
  reviewViewSchema,
} from "@dev.fast/review-protocol";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  type ReviewAgentHarness,
  type SessionRef,
  authoringSessionKey,
  parseAuthoringSessionKey,
  parseFreshSourceSessionHarness,
} from "../authoring-session";
import { preferredInstalledReviewAgent } from "../installed-review-agent";
import * as claudeCode from "../native-agent/claude-code";
import * as codex from "../native-agent/codex";
import type { AgentServer } from "../native-agent/native-session";
import * as opencode from "../native-agent/opencode";
import * as pi from "../native-agent/pi";
import { readProgressiveReviewPackageVersion } from "../package-paths";
import {
  type ProgressiveReviewSessionAgent,
  type ProgressiveReviewSourceKind,
  ProgressiveReviewTelemetry,
} from "../progressive-review-telemetry";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "../review-artifact-store";
import {
  dismissReview,
  markReviewViewed,
  restoreReview,
  reviewReapsAt,
  selectReapableReviews,
} from "../review-attention";
import type { ReviewDocumentBundle } from "../review-bundle";
import {
  readReviewDocumentFile,
  writeReviewDocumentFile,
} from "../review-document-files";
import { listReviewDocumentVersions } from "../review-document-versions";
import {
  ensureReviewPinnedCheckout,
  removeReviewManagedCheckouts,
} from "../review-head-checkout";
import {
  ReviewHomeScanError,
  type StoredReview,
  type StoredReviewRecord,
  bindReviewAuthorSession,
  countReviewComments,
  findReview,
  findReviewForRepair,
  findScopedReview,
  listReviews,
  parseStoredReviewRecord,
  persistStoredReviewRecord,
  reviewDescriptor,
  reviewTitleFromDocument,
  reviewsHomeDir,
  sealReviewCandidate,
  touchReviewAgentSession,
} from "../review-home";
import type { RunReviewInfoInput } from "../review-info";
import {
  ReviewDocumentFileNameSchema,
  ReviewDocumentFileWriteSchema,
  ReviewLifecycleTargetSchema,
  ReviewListRequestSchema,
  ReviewMetadataUpdateSchema,
  ReviewPublishRequestSchema,
  ReviewRebindRequestSchema,
  ReviewResolveRequestSchema,
  ReviewScaffoldRequestSchema,
} from "../review-lifecycle-contracts";
import { ReviewLiveMutationSchema } from "../review-live-document";
import {
  ReviewBusyError,
  reviewMutationFingerprint,
  withReviewMutationLock,
} from "../review-mutation-lock";
import {
  readReviewPreferences,
  writeReviewPreferences,
} from "../review-preferences";
import {
  type ActivatedPublication,
  type DocumentActivationCandidate,
  ReviewActivationConflictError,
  type ReviewActivationHooks,
  ReviewArtifactUnavailableError,
  ReviewMapPinsMismatchError,
  activateReviewPublication,
} from "../review-publication-activation";
import type {
  ExpectedReviewFields,
  PreparedDocumentCandidate,
  PreparedSoftwareMapCandidate,
} from "../review-publication-candidate";
import {
  type DocumentPublicationRecord,
  type SourceContext,
  parsePublicationRecord,
} from "../review-publication-record";
import { fingerprintAuthoring } from "../review-publication-staging";
import {
  ReviewOpenThreadsError,
  requireClosedThreadsForRepublish,
  requireCompletedAgentResponsesForRepublish,
} from "../review-publish-thread-gate";
import { clearReopenPending, markReopenPending } from "../review-reopen-marker";
import { ReviewRepairReadyRequestSchema } from "../review-repair-state";
import { runReviewScaffold } from "../review-scaffold";
import {
  deleteReviewState,
  listPublications,
  readPublication,
} from "../review-state-db";
import { devReviewHome, readOpenReviewThreadCount } from "../review-storage";
import { ReviewThreadsService } from "../review-threads-service";
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
  executableOnPath,
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
import {
  GlobalReviewDesktopVerbRelay,
  type ReviewDesktopVerbRelay,
} from "./global-verb-relay";
import {
  type ReviewHonoEnv,
  applyCorsHeaders,
  corsPreflightResponse,
  createNodeRequestListener,
  isAuthorizedRequest,
  jsonResponse,
  readBoundedRequestJson,
} from "./hono-http";
import { HttpJsonError, ReviewServerError } from "./http-json";
import { resolvePublishReview } from "./publish-preparation";
import {
  materializePublishRevision,
  reviewWithPresentedDocumentPins,
  reviewWithPublicationContext,
} from "./publish-stage";
import { captureSanitizedUiTelemetry } from "./review-api";
import { resolveReviewInfo } from "./review-info";
import {
  type MountedDocumentPublication,
  type MountedSoftwareMapPublication,
  agentEnvironment,
  publishReview,
  publishReviewSoftwareMap,
  rebindReview,
  repairReview,
} from "./review-lifecycle";
import {
  mutateLiveDocument,
  readLiveBundle,
  readLiveSnapshot,
} from "./review-live-authoring";
import { promoteReviewRepair } from "./review-repair-promotion";
import {
  HISTORICAL_UNAVAILABLE_ERROR,
  NEEDS_REPUBLISH_ERROR,
  NEEDS_REPUBLISH_MAP_ERROR,
  type ReviewSessionArtifactInput,
  type ReviewSessionArtifactMap,
  legacySessionArtifactFromBuildDir,
} from "./review-session-artifact";
import { resolveThreadsReview } from "./review-threads-target";
import {
  type ReviewSessionHandler,
  createReviewSessionHandler,
} from "./session-handler";
import { createTutorialService } from "./tutorial-service";

export interface PublishMountTiming {
  name: string;
  startEpochMs: number;
  endEpochMs: number;
}

/** What a mounted document publication reports back to the publishing CLI.
 * `revision` keeps the wire name the app and CLI already use; its value is a
 * publication ID, never a repository commit. */
interface MountedDocumentPublicationResult extends MountedDocumentPublication {
  ok: true;
  revision: string;
  url: string;
  timings: PublishMountTiming[];
}

// The renderer returns its mount step timings inside the verb result; parse
// them at this boundary rather than trusting the shape.
const MountVerbResultSchema = z.object({
  timings: z
    .array(
      z.object({
        name: z.string(),
        startEpochMs: z.number(),
        endEpochMs: z.number(),
      }),
    )
    .optional(),
});

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
  artifact: ReviewSessionArtifactInput;
  revision?: string;
  historicalRevision?: string;
  handler: ReviewSessionHandler;
  promoted: boolean;
  terminal: boolean;
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
  artifact: ReviewSessionArtifactInput;
  revision?: string;
  historicalRevision?: string;
  repairValidation?: boolean;
  readOnlyThreadsPath?: string;
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
  documentRevision: string;
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

export interface GlobalReviewServerInput {
  appPid: number;
  packageRoot: string;
  toolingRoot: string;
  cliRuntimePath?: string;
  port: number;
  token?: string;
  instanceId?: string;
  discoveryPath?: string;
  sessionHandlerFactory?: typeof createReviewSessionHandler;
  tutorialAuthoringSessionFactory?: typeof createTutorialAuthoringSession;
  tutorialAuthorSessionBinder?: typeof bindReviewAuthorSession;
  tutorialAgentResolver?: () => Promise<ReviewAgentHarness | undefined>;
  publishRuntime?: {
    materializePublishRevision: typeof materializePublishRevision;
    /** Observation points inside the publication activation, for tests that
     * interrupt it between its steps. */
    activationHooks?: ReviewActivationHooks;
  };
  telemetry?: ProgressiveReviewTelemetry;
  /* Object seam, like publishRuntime: a test supplies a relay whose dispatch
     it controls instead of reaching into the class. */
  relay?: ReviewDesktopVerbRelay;
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
  const relay = input.relay ?? new GlobalReviewDesktopVerbRelay();
  const sessions = new Map<string, ActiveReviewSession>();
  const threadServices = new Map<string, ReviewThreadsService>();
  function threadsFor(review: StoredReview): ReviewThreadsService {
    let service = threadServices.get(review.review.uuid);
    if (!service) {
      service = new ReviewThreadsService({
        reviewPath: path.join(review.dir, "review.mdx"),
        author: process.env.USER ?? "Reviewer",
      });
      threadServices.set(review.review.uuid, service);
    }
    return service;
  }
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
  let agentPreparation: Promise<void> | undefined;
  const harnesses = { "claude-code": claudeCode, codex, opencode, pi } as const;
  const agentServers = new Map<ReviewAgentHarness, AgentServer>();
  const agentServerFor = (harness: ReviewAgentHarness): AgentServer => {
    let server = agentServers.get(harness);
    if (!server) {
      server = harnesses[harness].server({
        runtimeDirectory: path.join(devReviewHome(), "native-agent"),
        reviewCliPath: discovery.cliPath,
        reviewCliRuntimePath: discovery.cliRuntimePath,
        desktopEndpoint: { baseUrl: urlForBoundPort(), token },
      });
      agentServers.set(harness, server);
    }
    return server;
  };
  async function prepareAgentServers(): Promise<void> {
    const status = await resolveInstalledReviewAgentStatus();
    await Promise.all(
      (["codex", "opencode"] as const).map(async (harness) => {
        // Installed here means the Review integration is enabled for this harness.
        if (
          !status.agents.some(
            (agent) => agent.target === harness && agent.installed,
          )
        )
          return;
        if (!(await executableOnPath(harness)) || closing) return;
        const startedAt = Date.now();
        try {
          await agentServerFor(harness).prepare?.();
          console.info(
            "[Review agent ready]",
            JSON.stringify({ harness, elapsedMs: Date.now() - startedAt }),
          );
        } catch (error) {
          console.error(`[Review] Could not prepare ${harness}`, error);
        }
      }),
    );
  }
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
  };
  // A source-run dev server has no built CLI to advertise.
  if (existsSync(cliPath)) {
    discovery.cliPath = cliPath;
    discovery.cliVersion = readProgressiveReviewPackageVersion(
      pathToFileURL(cliPath).href,
    );
    if (input.cliRuntimePath && existsSync(input.cliRuntimePath)) {
      discovery.cliRuntimePath = input.cliRuntimePath;
    }
  }

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
  // Native agents can read their draft before launch returns and a session is bound.
  // Every lookup is authenticated by the desktop token above.
  app.get("/agent-threads/:threadId", (context) => {
    const threadId = context.req.param("threadId");
    for (const session of sessions.values()) {
      const found = session.handler.findAgentThread(threadId);
      if (found) return globalJson(200, found);
    }
    return globalJson(404, {
      ok: false,
      error: `Comment thread not found: ${threadId}`,
    });
  });
  app.post("/app/focus", async () => {
    const result = await relay.dispatch("review-desktop", {
      name: "focusWindow",
      args: {},
    });
    return globalJson(result.ok ? 200 : 409, result);
  });
  app.post("/telemetry/event", async (context) => {
    try {
      const body = await readBoundedRequestJson(context.req.raw, undefined, {});
      const payload: JsonObject = isJsonObject(body) ? body : {};
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
        reviewDescriptor(stored, { retentionDays: dismissedRetentionDays }),
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
    const openBodyValue = await readBoundedRequestJson(
      context.req.raw,
      undefined,
      null,
    );
    const openBody = isJsonObject(openBodyValue) ? openBodyValue : null;
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
    let review: StoredReview | null;
    try {
      review = await findReview(uuid);
    } catch (error) {
      if (error instanceof ReviewHomeScanError) {
        const first = error.errors[0];
        if (first?.code === "REVIEW_BUSY") throw error;
        throw new ReviewServerError(
          first?.message ?? error.message,
          409,
          first?.code === "REPAIR_REQUIRED"
            ? "repair_required"
            : "migration_required",
        );
      }
      throw error;
    }
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
    const revisionValue = openBody
      ? jsonProperty(openBody, "revision")
      : undefined;
    const revision = jsonString(revisionValue);
    if (
      revisionValue !== undefined &&
      (revision === undefined || !/^[0-9a-f]{40}$/.test(revision))
    ) {
      throw new ReviewServerError(
        "Review revision must be a 40-character hexadecimal commit ID.",
        400,
        "invalid_revision",
      );
    }
    const requestedRevision =
      revision !== undefined &&
      revision !== review.review.presentedDocumentRevision
        ? revision
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
    const presented = await publicationSessionArtifact(
      viewed,
      documentRevision,
    );
    const active = await registerSerialized({
      review: presented.review,
      artifact: presented.artifact,
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

  /** The session a committed document publication serves. Reading a Review
   * imports its Git-era history first, so a presented pointer always answers
   * to a row. */
  async function publicationSessionArtifact(
    review: StoredReview,
    documentRevision: string,
  ): Promise<PresentedSessionArtifact> {
    const record = presentedDocumentRecord(review, documentRevision);
    const map = await presentedMapArtifact(review);
    const document = await storedDocumentBundle(review, record);
    return {
      review: reviewWithPublicationContext(review, record),
      artifact: {
        reviewUuid: review.review.uuid,
        origin: {
          kind: "publication",
          publicationId: documentRevision,
          mapPublicationId: map.publicationId,
        },
        document: document
          ? { bundle: document }
          : { unavailable: NEEDS_REPUBLISH_ERROR },
        map: map.artifact,
        title: record.title,
        sourcePath: path.join(review.dir, "review.mdx"),
        documentUpdatedAtMs: Date.parse(record.createdAt),
      },
    };
  }

  /** A historical open restores the publication's own code context and the
   * map it was published beside. Every published version is a row, so an
   * unknown ID is simply not one of this Review's versions. */
  async function historicalPublicationSessionArtifact(
    review: StoredReview,
    revision: string,
  ): Promise<PresentedSessionArtifact> {
    const row = readPublication(review.dir, revision, "document");
    const record = row ? parsePublicationRecord(row.record) : null;
    if (record?.kind !== "document")
      throw new ReviewServerError(
        "Review version not found.",
        404,
        "revision_not_found",
      );
    const document = await storedDocumentBundle(review, record);
    return {
      review: reviewWithPublicationContext(review, record),
      artifact: {
        reviewUuid: review.review.uuid,
        origin: {
          kind: "publication",
          publicationId: revision,
          mapPublicationId: record.pairedMapPublicationId,
        },
        document: document
          ? { bundle: document }
          : { unavailable: HISTORICAL_UNAVAILABLE_ERROR },
        map: await historicalMapArtifact(review, record.pairedMapPublicationId),
        title: record.title,
        sourcePath: path.join(review.dir, "review.mdx"),
        documentUpdatedAtMs: Date.parse(record.createdAt),
      },
    };
  }

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
    const presented = await historicalPublicationSessionArtifact(
      review,
      revision,
    );
    const active = await registerSerialized({
      review: presented.review,
      artifact: presented.artifact,
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
    const body = await readBoundedRequestJson(context.req.raw);
    const value = isJsonObject(body)
      ? jsonProperty(body, "dismissedRetentionDays")
      : undefined;
    const dismissedRetentionDays = value === null ? null : jsonNumber(value);
    if (dismissedRetentionDays === undefined) {
      throw new ReviewServerError(
        "dismissedRetentionDays must be a number or null.",
        400,
      );
    }
    const saved = await writeReviewPreferences({ dismissedRetentionDays });
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
    const applyInput: Parameters<typeof applyCliInstall>[0] = {
      packageRoot: input.packageRoot,
      targets: request.targets,
    };
    if (request.shim !== undefined) applyInput.shim = request.shim;
    if (request.autoUpdate) applyInput.autoUpdate = true;
    if (request.fff) applyInput.fff = true;
    if (request.trace !== undefined) applyInput.trace = request.trace;
    if (discovery.cliPath) applyInput.cliPath = discovery.cliPath;
    if (discovery.cliRuntimePath) {
      applyInput.cliRuntimePath = discovery.cliRuntimePath;
    }
    const result = await applyCliInstall(applyInput);
    const body: ReviewCliInstallApplyResponse = {
      ok: result.code === 0,
      output: result.output,
    };
    if (result.shimPath) body.shimPath = result.shimPath;
    return globalJson(result.code === 0 ? 200 : 500, body);
  });
  app.post("/install/remove", async (context) => {
    const request = parseReviewCliInstallApplyRequest(
      await readBoundedRequestJson(context.req.raw),
    );
    const removeInput: Parameters<typeof removeCliInstall>[0] = {
      targets: request.targets,
    };
    if (request.shim) removeInput.shim = true;
    if (request.fff) removeInput.fff = true;
    if (request.trace) removeInput.trace = true;
    const result = await removeCliInstall(removeInput);
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
  app.post("/lifecycle/scaffold", async (context) => {
    const request = ReviewScaffoldRequestSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(
      200,
      await runReviewScaffold({
        ...request,
        env: agentEnvironment(request.agent),
        toolingRoot: input.toolingRoot,
      }),
    );
  });
  app.post("/lifecycle/open-thread-count", async (context) => {
    const request = z
      .strictObject({ reviewUuid: z.uuid() })
      .parse(await readBoundedRequestJson(context.req.raw));
    const review = await findReview(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return globalJson(200, readOpenReviewThreadCount(review.dir));
  });
  app.post("/lifecycle/document/read", async (context) => {
    const request = z
      .strictObject({
        reviewUuid: z.uuid(),
        name: ReviewDocumentFileNameSchema,
      })
      .parse(await readBoundedRequestJson(context.req.raw));
    const review = await findReview(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return globalJson(200, await readReviewDocumentFile(review, request.name));
  });
  app.post("/lifecycle/document/live", async (context) => {
    const request = z
      .strictObject({ reviewUuid: z.uuid() })
      .parse(await readBoundedRequestJson(context.req.raw));
    return withReviewLock(request.reviewUuid, async () => {
      const review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      return globalJson(200, await readLiveSnapshot(review));
    });
  });
  app.post("/lifecycle/document/mutate", async (context) => {
    const request = ReviewLiveMutationSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    const snapshot = await withReviewLock(request.reviewUuid, async () => {
      const review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      return mutateLiveDocument(review, request);
    });
    for (const session of sessions.values()) {
      if (
        session.review.review.uuid !== request.reviewUuid ||
        session.historicalRevision ||
        !session.promoted
      )
        continue;
      broadcastGlobal({
        event: "review-data-changed",
        uuid: request.reviewUuid,
        sessionId: session.descriptor.sessionId,
        documentChanged: true,
      });
    }
    return globalJson(200, snapshot);
  });
  app.post("/lifecycle/metadata", async (context) => {
    const request = ReviewMetadataUpdateSchema.extend({
      reviewUuid: z.uuid(),
    }).parse(await readBoundedRequestJson(context.req.raw));
    const record = await withReviewLock(request.reviewUuid, async () => {
      const stored = await findReview(request.reviewUuid);
      if (!stored) throw new ReviewServerError("Review not found.", 404);
      if (stored.review.title !== request.expectedTitle)
        throw new ReviewServerError(
          "Review title changed; read metadata again before updating.",
          409,
        );
      const review = {
        ...stored.review,
        title: request.title,
        titleOverride: request.title,
      };
      await persistStoredReviewRecord(stored.dir, review);
      for (const session of sessions.values()) {
        if (session.review.review.uuid === request.reviewUuid)
          session.review = {
            ...session.review,
            review: {
              ...session.review.review,
              title: review.title,
              titleOverride: review.titleOverride,
            },
          };
      }
      return review;
    });
    broadcastGlobal({
      event: "review-metadata-changed",
      uuid: request.reviewUuid,
      title: record.title,
    });
    return globalJson(200, record);
  });
  app.post("/lifecycle/document/write", async (context) => {
    const request = ReviewDocumentFileWriteSchema.extend({
      reviewUuid: z.uuid(),
    }).parse(await readBoundedRequestJson(context.req.raw));
    return withReviewLock(request.reviewUuid, async () => {
      const review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      return globalJson(200, await writeReviewDocumentFile(review, request));
    });
  });
  app.post("/lifecycle/threads/resolve-target", async (context) => {
    const request = ReviewLifecycleTargetSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(
      200,
      await resolveThreadsReview(request.cwd, request.reviewUuid),
    );
  });
  app.post("/lifecycle/threads/snapshot", async (context) => {
    const request = z
      .strictObject({ reviewUuid: z.uuid() })
      .parse(await readBoundedRequestJson(context.req.raw));
    const review = await findReview(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return globalJson(200, {
      ok: true,
      snapshot: threadsFor(review).snapshot(),
    });
  });
  app.post("/lifecycle/threads/command", async (context) => {
    const request = z
      .strictObject({
        reviewUuid: z.uuid(),
        command: ReviewThreadsCommandSchema,
      })
      .parse(await readBoundedRequestJson(context.req.raw));
    return withReviewLock(request.reviewUuid, async () => {
      const review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      const commit = threadsFor(review).dispatch(request.command);
      if (!commit)
        throw new ReviewServerError(
          `Comment thread not found: ${"threadId" in request.command ? request.command.threadId : "unknown"}`,
          404,
        );
      return globalJson(200, { ok: true, commit });
    });
  });
  app.post("/lifecycle/threads/reply", async (context) => {
    const request = z
      .strictObject({
        reviewUuid: z.uuid(),
        mutationId: z.uuid(),
        threadId: z.string().min(1),
        messageId: z.uuid(),
        author: z.string().trim().min(1),
        body: z.string().trim().min(1),
        format: z.enum(["plain", "markdown"]),
      })
      .parse(await readBoundedRequestJson(context.req.raw));
    return withReviewLock(request.reviewUuid, async () => {
      const review = await findReview(request.reviewUuid);
      if (!review) throw new ReviewServerError("Review not found.", 404);
      const commit = threadsFor(review).appendAgentMessage(request);
      if (!commit)
        throw new ReviewServerError(
          `Comment thread not found: ${request.threadId}`,
          404,
        );
      return globalJson(200, { ok: true, commit });
    });
  });
  app.post("/lifecycle/rebind", async (context) => {
    const request = ReviewRebindRequestSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(
      200,
      await rebindReview({
        ...request,
        env: agentEnvironment(request.agent),
        toolingRoot: input.toolingRoot,
      }),
    );
  });
  app.post("/lifecycle/resolve", async (context) => {
    const request = ReviewResolveRequestSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(
      200,
      await resolvePublishReview(request.cwd, request.reviewUuid, {
        includeTerminal: request.includeTerminal,
      }),
    );
  });
  app.post("/lifecycle/find", async (context) => {
    const request = z
      .strictObject({
        reviewUuid: z.uuid(),
        worktreePath: z.string(),
        includeTerminal: z.boolean().optional(),
        includeLegacySchema: z.boolean().optional(),
      })
      .parse(await readBoundedRequestJson(context.req.raw));
    return globalJson(200, await findScopedReview(request.reviewUuid, request));
  });
  app.post("/lifecycle/list", async (context) =>
    globalJson(
      200,
      await listReviews(
        ReviewListRequestSchema.parse(
          await readBoundedRequestJson(context.req.raw),
        ),
      ),
    ),
  );
  app.post("/lifecycle/checkpoint", async (context) => {
    const request = z
      .strictObject({ reviewUuid: z.uuid(), message: z.string().min(1) })
      .parse(await readBoundedRequestJson(context.req.raw));
    const review = await findReview(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return globalJson(
      200,
      await withReviewLock(request.reviewUuid, () =>
        sealReviewCandidate(review.dir, request.message),
      ),
    );
  });
  app.post("/lifecycle/agent-session", async (context) => {
    const request = z
      .strictObject({
        reviewUuid: z.uuid(),
        session: z.string(),
        role: ReviewAgentSessionRoleSchema,
      })
      .parse(await readBoundedRequestJson(context.req.raw));
    const review = await findReview(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return globalJson(
      200,
      await withReviewLock(request.reviewUuid, () =>
        touchReviewAgentSession(review, request.session, request.role),
      ),
    );
  });
  app.post("/lifecycle/publish", async (context) =>
    globalJson(
      200,
      await publishReview(
        ReviewPublishRequestSchema.parse(
          await readBoundedRequestJson(context.req.raw),
        ),
        completeDocumentPublication,
      ),
    ),
  );
  app.post("/lifecycle/map/publish", async (context) =>
    globalJson(
      200,
      await publishReviewSoftwareMap(
        ReviewPublishRequestSchema.parse(
          await readBoundedRequestJson(context.req.raw),
        ),
        completeMapPublication,
      ),
    ),
  );
  app.post("/lifecycle/repair", async (context) =>
    globalJson(
      200,
      await repairReview(
        ReviewLifecycleTargetSchema.extend({ reviewUuid: z.uuid() }).parse(
          await readBoundedRequestJson(context.req.raw),
        ),
        completeReviewRepair,
      ),
    ),
  );
  app.post("/repair-ready", async (context) => {
    const request = ReviewRepairReadyRequestSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(201, await completeReviewRepair(request));
  });
  app.get("/events", (context) => openGlobalEvents(context));
  app.get("/control", (context) => openControlEvents(context));
  app.post("/control/result", async (context) => {
    const accepted = relay.acceptResult(
      await readBoundedRequestJson(context.req.raw),
    );
    return globalJson(accepted ? 200 : 404, { ok: accepted });
  });
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
    const busyScan =
      error instanceof ReviewHomeScanError
        ? error.errors.find((failure) => failure.code === "REVIEW_BUSY")
        : undefined;
    const busyError =
      error instanceof ReviewBusyError
        ? error
        : busyScan
          ? new ReviewBusyError(busyScan.reviewDir)
          : undefined;
    if (busyError)
      return globalJson(409, {
        ok: false,
        code: "review_busy",
        retryable: true,
        error: busyError.message,
      });
    const serverError =
      error instanceof ReviewServerError ||
      error instanceof ReviewOpenThreadsError
        ? error
        : activationRefusal(error);
    const message = toError(error).message;
    return globalJson(
      serverError?.statusCode ?? httpJsonStatus(error),
      serverError?.code
        ? { ok: false, code: serverError.code, error: message }
        : { ok: false, error: message },
    );
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

  // Publication preparation validated, bundled, and sealed the revision; the server
  // materializes it, has the app mount it off-screen, and promotes it only
  // when that mount is clean.
  function mountStepTimings(
    validation: ReviewVerbResponse,
  ): PublishMountTiming[] {
    if (!validation.ok) return [];
    const parsed = MountVerbResultSchema.safeParse(validation.result);
    return parsed.success ? (parsed.data.timings ?? []) : [];
  }

  async function completeReviewRepair(
    request: ReturnType<typeof ReviewRepairReadyRequestSchema.parse>,
  ) {
    const review = await findReviewForRepair(request.reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    return promoteReviewRepair({
      review,
      request,
      sessions,
      registerSerialized,
      withReviewLock,
      dispatch: (sessionId, verb) => relay.dispatch(sessionId, verb),
      startSessionTelemetry,
      closeSession: (session, reason) => closeSession(session, reason, false),
      broadcast: broadcastGlobal,
      onPromoted: () => {
        threadServices.delete(request.reviewUuid);
      },
    });
  }

  async function completeDocumentPublication(
    candidate: PreparedDocumentCandidate,
    options: { view?: ReviewView; agent?: SessionRef },
  ): Promise<MountedDocumentPublicationResult> {
    const review = await publishingReview(candidate.reviewUuid, options.agent);
    return mountPublishedDocument(review, candidate, options.view);
  }

  async function completeMapPublication(
    candidate: PreparedSoftwareMapCandidate,
    options: { agent?: SessionRef },
  ): Promise<MountedSoftwareMapPublication> {
    const review = await publishingReview(candidate.reviewUuid, options.agent);
    return mountPublishedSoftwareMap(review, candidate);
  }

  /** The record the mount guards against, with the publishing agent stamped. */
  async function publishingReview(
    reviewUuid: string,
    agent: SessionRef | undefined,
  ): Promise<StoredReview> {
    const review = await findReview(reviewUuid);
    if (!review) throw new ReviewServerError("Review not found.", 404);
    if (!agent) return review;
    return withReviewLock(reviewUuid, () =>
      touchReviewAgentSession(review, authoringSessionKey(agent), "publisher"),
    );
  }

  async function mountPublishedDocument(
    review: StoredReview,
    candidate: PreparedDocumentCandidate,
    view?: ReviewView,
  ): Promise<MountedDocumentPublicationResult> {
    // Each mount step reports its wall-clock interval so the publishing CLI
    // can show where desktop time went; the CLI only sees the round-trip.
    const timings: PublishMountTiming[] = [];
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const startEpochMs = Date.now();
      try {
        return await fn();
      } finally {
        timings.push({ name, startEpochMs, endEpochMs: Date.now() });
      }
    };
    rejectChangedReviewRecord(review, candidate.expected);
    if (!review.review.sourceCommit) {
      throw new ReviewServerError(
        `Review ${review.review.uuid} is not bound to a source commit.`,
        409,
        "review_unbound",
      );
    }
    const document = await readReviewDocumentArtifact(
      review.dir,
      candidate.artifactHash,
    );
    if (!document) {
      throw new ReviewServerError(
        `The prepared document artifact ${candidate.artifactHash} is unavailable.`,
        422,
        "document_artifact_unavailable",
      );
    }
    const map = await presentedMapArtifact(review);
    const successor = await timed("register session", async () =>
      registerSerialized({
        review,
        artifact: {
          reviewUuid: review.review.uuid,
          origin: { kind: "candidate" },
          document: { bundle: document },
          map: map.artifact,
          title: candidate.title,
          sourcePath: path.join(review.dir, "review.mdx"),
        },
        promoted: false,
      }),
    );
    let mirrorWarning: string | undefined;
    let announceWarning: string | undefined;
    let publicationId!: string;
    let mapPublicationId: string | null = null;
    try {
      // The app mounts the unpromoted session off-screen first. A failed
      // mount fails the publish before activation, so the reviewer keeps the
      // last committed publication on screen.
      const validation = await timed("validate canvas mount", () =>
        relay.dispatch(successor.descriptor.sessionId, {
          name: "validateCanvasMount",
          args: {},
        }),
      );
      if (!validation.ok) {
        await telemetry.capturePublishGateRejected({ gate: "publish_ready" });
        throw new ReviewServerError(
          `Review document failed to mount: ${validation.error ?? "unknown error"}`,
          422,
          "mount_validation_failed",
        );
      }
      // The renderer reports the mount's own steps (asset load, session and
      // module fetches, first commit, settle timer) inside the verb result.
      for (const step of mountStepTimings(validation)) {
        timings.push({ ...step, name: `mount: ${step.name}` });
      }
      await timed("activate publication", () =>
        withReviewLock(review.review.uuid, async () => {
          requireLiveSession(successor);
          const activated = await activateReviewPublication({
            reviewDir: review.dir,
            expected: { guarded: candidate.expected },
            candidates: [documentActivationCandidate(review.review, candidate)],
            precheck: () => requireUnchangedAuthoring(review.dir, candidate),
            gates: [
              (latest) => rejectTerminalPublication(latest),
              (latest) =>
                requireClosedThreadsForRepublish({
                  dir: review.dir,
                  review: latest,
                }),
              (latest) =>
                requireCompletedAgentResponsesForRepublish({
                  dir: review.dir,
                  review: latest,
                }),
            ],
            updateRecord: promoteReviewRecord,
            hooks: publishRuntime.activationHooks,
          });
          const published = documentPublicationOf(activated.published);
          mirrorWarning = activated.mirrorWarning;
          publicationId = published.publicationId;
          mapPublicationId = published.record.pairedMapPublicationId;
          successor.review = { ...review, review: activated.review };
          successor.revision = publicationId;
          successor.artifact.origin = {
            kind: "publication",
            publicationId,
            mapPublicationId,
          };
          successor.artifact.documentUpdatedAtMs = Date.parse(
            published.record.createdAt,
          );
          successor.promoted = true;
          announceWarning = await warnInsteadOfFailing(async () => {
            await startSessionTelemetry(successor);
            await clearReopenPending(successor.review.review.worktreePath);
            broadcastGlobal({
              event: "review-status-changed",
              uuid: successor.review.review.uuid,
              status: "awaiting-review",
            });
            await announcePromotedSession(successor);
          });
        }),
      );
    } finally {
      if (!successor.promoted) {
        await closeSession(successor, "closed", false);
      }
    }
    // The publication is committed: from here on nothing can fail the
    // publish. A focus failure is a warning — the publication is live either
    // way — and a prune failure is ignored.
    const focus = await timed("focus canvas", () =>
      relay.dispatch(successor.descriptor.sessionId, revealVerb(view)),
    );
    // Publication mounts write nothing under `.build`; this only ages out
    // Git-era materializations until Task 13 removes them entirely.
    await timed("prune builds", () =>
      pruneReviewBuilds(review.dir, []).catch(() => undefined),
    );
    const mounted: MountedDocumentPublicationResult = {
      ok: true,
      revision: publicationId,
      publicationId,
      mapPublicationId,
      sessionId: successor.descriptor.sessionId,
      url: successor.descriptor.sessionUrl,
      timings,
    };
    if (mirrorWarning) mounted.mirrorWarning = mirrorWarning;
    if (announceWarning) mounted.announceWarning = announceWarning;
    if (!focus.ok) mounted.focusWarning = focus.error;
    return mounted;
  }

  async function mountPublishedSoftwareMap(
    review: StoredReview,
    candidate: PreparedSoftwareMapCandidate,
  ): Promise<MountedSoftwareMapPublication> {
    rejectChangedReviewRecord(review, candidate.expected);
    const documentRevision = review.review.presentedDocumentRevision;
    if (!documentRevision) {
      throw new ReviewServerError(
        "The Review document is not published.",
        409,
        "review_unpublished",
      );
    }
    const documentRecord = presentedDocumentRecord(review, documentRevision);
    // The activation rechecks this inside its transaction; failing here keeps
    // a mismatched map from ever being mounted.
    if (
      documentRecord.sourceCommit !== candidate.headCommit ||
      documentRecord.baseCommit !== candidate.baseCommit
    ) {
      throw new ReviewServerError(
        "The software map pins do not match the published Review document.",
        422,
        "map_pins_mismatch",
      );
    }
    const document = await publishedDocumentArtifact(review, documentRecord);
    const map = await readReviewSoftwareMapArtifact(
      review.dir,
      candidate.artifactHash,
    );
    if (!map) {
      throw new ReviewServerError(
        `The prepared software map artifact ${candidate.artifactHash} is unavailable.`,
        422,
        "map_artifact_unavailable",
      );
    }
    const presentedReview = reviewWithPublicationContext(
      review,
      documentRecord,
    );
    const successor = await registerSerialized({
      review: presentedReview,
      artifact: {
        reviewUuid: presentedReview.review.uuid,
        origin: { kind: "candidate" },
        document: { bundle: document },
        map: { bundle: map },
        title: documentRecord.title,
        sourcePath: path.join(review.dir, "review.mdx"),
        documentUpdatedAtMs: Date.parse(documentRecord.createdAt),
      },
      promoted: false,
    });
    let publicationId!: string;
    let mirrorWarning: string | undefined;
    let announceWarning: string | undefined;
    try {
      const validation = await relay.dispatch(successor.descriptor.sessionId, {
        name: "validateCanvasMount",
        args: {},
      });
      if (!validation.ok) {
        await telemetry.capturePublishGateRejected({
          gate: "map_publish_ready",
        });
        throw new ReviewServerError(
          `Software map failed to load: ${validation.error ?? "unknown error"}`,
          422,
          "map_validation_failed",
        );
      }
      await withReviewLock(review.review.uuid, async () => {
        requireLiveSession(successor);
        const activated = await activateReviewPublication({
          reviewDir: review.dir,
          expected: { guarded: candidate.expected },
          candidates: [
            {
              kind: "map",
              artifactHash: candidate.artifactHash,
              headCommit: candidate.headCommit,
              baseCommit: candidate.baseCommit,
              context: candidate.context,
              operation: "map-publish",
            },
          ],
          gates: [(latest) => rejectTerminalPublication(latest)],
          updateRecord: (latest) => latest,
          hooks: publishRuntime.activationHooks,
        });
        publicationId = mapPublicationOf(activated.published);
        mirrorWarning = activated.mirrorWarning;
        successor.review = { ...presentedReview, review: activated.review };
        successor.artifact.origin = {
          kind: "publication",
          publicationId: documentRevision,
          mapPublicationId: publicationId,
        };
        successor.promoted = true;
        announceWarning = await warnInsteadOfFailing(async () => {
          await startSessionTelemetry(successor);
          await announcePromotedSession(successor);
        });
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
    const mounted: MountedSoftwareMapPublication = { publicationId };
    if (mirrorWarning) mounted.mirrorWarning = mirrorWarning;
    if (announceWarning) mounted.announceWarning = announceWarning;
    return mounted;
  }

  /**
   * Announcing an already-committed publication cannot un-publish it, so a
   * failure after the transaction is reported to the publisher, never thrown:
   * the row and the pointer stand either way.
   */
  async function warnInsteadOfFailing(
    announce: () => Promise<void>,
  ): Promise<string | undefined> {
    try {
      await announce();
      return undefined;
    } catch (error) {
      console.error(error);
      return `The Review was published, but the desktop could not announce it: ${toError(error).message}`;
    }
  }

  /** The promoted session takes over the review: announce it and close the
   * sessions it replaces. */
  async function announcePromotedSession(
    successor: ActiveReviewSession,
  ): Promise<void> {
    broadcastGlobal({
      event: "session-registered",
      session: successor.descriptor,
      review: await reviewDescriptor(successor.review, {
        retentionDays: (await readReviewPreferences()).dismissedRetentionDays,
      }),
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
  }

  function requireLiveSession(successor: ActiveReviewSession): void {
    if (
      successor.closing ||
      sessions.get(successor.descriptor.sessionId) !== successor
    ) {
      throw new ReviewServerError("Review session is unavailable.", 404);
    }
  }

  /** The document publication a map is checked and presented against. */
  function presentedDocumentRecord(
    review: StoredReview,
    documentRevision: string,
  ): DocumentPublicationRecord {
    const row = readPublication(review.dir, documentRevision, "document");
    const record = row ? parsePublicationRecord(row.record) : null;
    if (record?.kind !== "document") {
      throw new ReviewServerError(
        `Publication ${documentRevision} is not a Review document.`,
        422,
        "document_artifact_unavailable",
      );
    }
    return record;
  }

  async function publishedDocumentArtifact(
    review: StoredReview,
    record: DocumentPublicationRecord,
  ): Promise<ReviewDocumentBundle> {
    const bundle =
      record.artifact.state === "stored"
        ? await readReviewDocumentArtifact(review.dir, record.artifact.hash)
        : null;
    if (!bundle) {
      throw new ReviewServerError(
        "The published Review document artifact is unavailable.",
        422,
        "document_artifact_unavailable",
      );
    }
    return bundle;
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
      documentRevision,
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
        artifact: await legacySessionArtifactFromBuildDir({
          reviewUuid: prepared.review.review.uuid,
          revision: prepared.documentRevision,
          buildDir: path.dirname(prepared.documentPath),
          routePath: "/",
          softwareMapRootPath: prepared.softwareMapRootPath,
        }),
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
      deleteReviewState(dir);
      threadServices.delete(uuid);
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
    deleteReviewState(review.dir);
    threadServices.delete(review.review.uuid);
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
    const sessionId = crypto.randomUUID();
    const sessionUrl = `${urlForBoundPort()}/sessions/${encodeURIComponent(sessionId)}`;
    const descriptor: ReviewSessionDescriptor = {
      sessionId,
      sessionUrl,
      reviewUuid: registration.review.review.uuid,
      routePath: "/",
      startedAt: Date.now(),
    };
    if (registration.historicalRevision) {
      descriptor.historicalRevision = registration.historicalRevision;
    }
    const sourceCommit = registration.review.review.sourceCommit;
    let sourceUnavailable: string | undefined;
    const { baseRootPath, headRootPath } =
      registration.checkoutRoots ??
      (await ensureReviewCheckouts(registration.review, sourceCommit).catch(
        (error) => {
          if (!registration.historicalRevision) throw error;
          sourceUnavailable = `The pinned source commits are unavailable: ${error instanceof Error ? error.message : String(error)}`;
          return { baseRootPath: undefined, headRootPath: undefined };
        },
      ));
    if (sourceUnavailable) descriptor.sourceUnavailable = sourceUnavailable;
    const sessionWire = sessionWireFor(
      registration.review,
      descriptor,
      boundPort,
      registration.artifact.sourcePath,
      baseRootPath,
      headRootPath,
    );
    let active!: ActiveReviewSession;
    const handler = await sessionHandlerFactory({
      rootPath: registration.review.review.worktreePath,
      reviewRootPath: registration.review.dir,
      toolingRoot: input.toolingRoot,
      artifact: registration.artifact,
      stateReviewPath: path.join(registration.review.dir, "review.mdx"),
      getLiveBundle: registration.historicalRevision
        ? undefined
        : async () => {
            // Candidate mount validation may run while publication owns the lock.
            if (!active.promoted) return null;
            return withReviewLock(registration.review.review.uuid, async () => {
              const latest = await findReview(registration.review.review.uuid);
              if (
                latest?.review.baseCommit !== active.review.review.baseCommit ||
                latest?.review.sourceCommit !==
                  active.review.review.sourceCommit
              )
                return null;
              return latest ? readLiveBundle(latest) : null;
            });
          },
      threadsService: registration.historicalRevision
        ? undefined
        : () => threadsFor(active.review),
      readOnlyThreadsPath: registration.readOnlyThreadsPath,
      routePath: "/",
      token,
      sessionId,
      reviewUuid: registration.review.review.uuid,
      mode: registration.historicalRevision
        ? {
            kind: "historical",
            revision: registration.historicalRevision,
            record: registration.review.review,
          }
        : registration.repairValidation
          ? {
              kind: "repairValidation",
              record: registration.review.review,
              isPromoted: () => active.promoted,
            }
          : { kind: "live" },
      sourceUnavailable,
      listDocumentVersions: async () => {
        const latest = await (
          registration.repairValidation && !active.promoted
            ? findReviewForRepair
            : findReview
        )(registration.review.review.uuid);
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
      onAgentStatus: (threadId, status, error) => {
        const event: Extract<
          ReviewDesktopGlobalEvent,
          { event: "review-agent-status" }
        > = {
          event: "review-agent-status",
          uuid: registration.review.review.uuid,
          sessionId,
          threadId,
          status,
        };
        if (error !== undefined) event.error = error;
        broadcastGlobal(event);
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
      agentServer: agentServerFor,
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
    active = {
      descriptor,
      review: registration.review,
      artifact: registration.artifact,
      revision: registration.revision,
      historicalRevision: registration.historicalRevision,
      handler,
      promoted: registration.promoted,
      terminal: false,
      closing: false,
      telemetryStarted: false,
      telemetryEnded: false,
      appSessionId: registration.appSessionId,
      tutorialPreparation: registration.tutorialPreparation,
      resolveQuestionSourceSession: registration.resolveQuestionSourceSession,
    };
    sessions.set(sessionId, active);
    await startSessionTelemetry(active);
    if (registration.announce) {
      const event: ReviewDesktopGlobalEvent = {
        event: "session-registered",
        session: descriptor,
      };
      if (registration.background) event.background = true;
      broadcastGlobal(event);
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
      active.terminal = true;
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
    reason: "closed" | "replaced" | "app-exit",
    terminal: boolean,
  ): Promise<void> {
    if (active.closing) return;
    active.closing = true;
    sessions.delete(active.descriptor.sessionId);
    /* Closing the window ends the session, never the review. Dismissal is the
       only reader action that ends a review, and it has its own endpoint. This
       branch used to reject the review, which made closing a tab and finishing
       a review indistinguishable. */
    if (terminal && active.promoted && !active.terminal) {
      active.terminal = true;
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
      return await withReviewMutationLock(
        path.join(reviewsHomeDir(), reviewUuid),
        operation,
      );
    } finally {
      release();
      if (reviewLocks.get(reviewUuid) === chain) reviewLocks.delete(reviewUuid);
    }
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
      agentPreparation = prepareAgentServers().catch((error) =>
        console.error(
          "[Review] Could not inspect enabled agent integrations",
          error,
        ),
      );
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
      await agentPreparation;
      await Promise.all(
        [...sessions.values()].map((session) =>
          closeSession(session, "app-exit", false).catch(() => undefined),
        ),
      );
      relay.close();
      threadServices.clear();
      for (const client of globalClients) client.close();
      globalClients.clear();
      await Promise.all(
        [...agentServers.values()].map((server) => server.close()),
      );
      await closeHttpServer(httpServer);
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

/** The review fields that identify which agent a review belongs to. */
export type ReviewAgentSessionSource = Pick<
  ReviewRecord,
  "sourceSession" | "agentSessions"
>;

export function reviewAgentKind(
  review: ReviewAgentSessionSource,
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
  review: ReviewAgentSessionSource,
  role: "publisher" | "author",
): string | undefined {
  return Object.entries(review.agentSessions ?? {})
    .filter(([, attribution]) => attribution.roles.includes(role))
    .sort((left, right) =>
      right[1].lastSeenAt.localeCompare(left[1].lastSeenAt),
    )[0]?.[0];
}

function parseInfoRequest(input: JsonValue): RunReviewInfoInput {
  if (!isJsonObject(input)) {
    throw new HttpJsonError("Info request must be an object.", 400);
  }
  const allowed = new Set(["cwd", "all", "reviewUuid"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new HttpJsonError("Info request has unexpected fields.", 400);
  }
  const cwd = jsonString(jsonProperty(input, "cwd"));
  if (cwd === undefined || !cwd.trim()) {
    throw new HttpJsonError("Info request requires cwd.", 400);
  }
  const all = jsonProperty(input, "all");
  if (all !== undefined && jsonBoolean(all) === undefined) {
    throw new HttpJsonError("Info all must be boolean.", 400);
  }
  const reviewUuidValue = jsonProperty(input, "reviewUuid");
  const reviewUuid = jsonString(reviewUuidValue);
  if (
    reviewUuidValue !== undefined &&
    (reviewUuid === undefined || !reviewUuid.trim())
  ) {
    throw new HttpJsonError("Info reviewUuid must be a non-empty string.", 400);
  }
  if (all === true && reviewUuidValue !== undefined) {
    throw new HttpJsonError("Info all and reviewUuid cannot be combined.", 400);
  }
  const request: RunReviewInfoInput = { cwd };
  if (all) request.all = true;
  if (reviewUuid !== undefined) request.reviewUuid = reviewUuid.trim();
  return request;
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
    // SAFETY: fs/promises rejects with a Node ErrnoException carrying `code`.
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
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    signal: request.signal,
  };
  if (hasBody) init.duplex = "half";
  return handler.handle(new Request(target, init), env);
}

function sessionWireFor(
  review: StoredReview,
  descriptor: ReviewSessionDescriptor,
  port: number,
  sourcePath: string,
  baseRootPath?: string,
  headRootPath?: string,
): ReviewSessionWire {
  const headRef = review.review.sourceCommit;
  if (!headRef && !descriptor.historicalRevision) {
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
  const wire: ReviewSessionWire = {
    sessionId: descriptor.sessionId,
    rootPath: review.review.worktreePath,
    baseRootPath,
    headRootPath,
    baseRef: review.review.baseCommit,
    headRef: headRef ?? undefined,
    pullRequestNumber: review.review.pullRequestNumber ?? undefined,
    pullRequestUrl: review.review.pullRequestUrl ?? undefined,
    routePath: descriptor.routePath,
    appUrl: descriptor.sessionUrl,
    appPort: port,
    serverUrl: new URL(descriptor.sessionUrl).origin,
    sessionUrl: descriptor.sessionUrl,
    storageDir: review.dir,
    reviewPath: sourcePath,
    agent: authoringAgent,
    freshQuestionHarness,
    codexThreadId:
      authoringAgent?.harness === "codex"
        ? authoringAgent.sessionId
        : undefined,
    startedAt: descriptor.startedAt,
  };
  if (descriptor.historicalRevision) {
    wire.historicalRevision = descriptor.historicalRevision;
  }
  return wire;
}

/** The record a committed document publication leaves behind. Pure: the
 * activation primitive owns the presentation pointers and the write. */
function promoteReviewRecord(
  latest: StoredReviewRecord,
  published: readonly ActivatedPublication[],
): StoredReviewRecord {
  const document = documentPublicationOf(published);
  const review: StoredReviewRecord = {
    ...latest,
    status: "awaiting-review",
    lastPublishedAt: new Date().toISOString(),
    /* A publish is new work, so the review earns attention again and returns
       to Home as new. This also rescues a review that was dismissed and then
       updated rather than dropped. */
    viewedAt: null,
    dismissedAt: null,
  };
  // Precedence, against the record as it stands at commit time: the
  // reviewer's override wins, then the published document's own heading, and
  // a document with no heading keeps the stored title.
  if (latest.titleOverride) review.title = latest.titleOverride;
  else if (document.record.titleSource !== "stored")
    review.title = document.record.title;
  return review;
}

/** Title precedence for a document publication: the reviewer's override, then
 * the published document's own H1, then the title already stored. */
function documentActivationCandidate(
  record: StoredReviewRecord,
  candidate: PreparedDocumentCandidate,
): DocumentActivationCandidate {
  const override = record.titleOverride;
  return {
    kind: "document",
    artifactHash: candidate.artifactHash,
    title: override ?? candidate.title ?? record.title,
    titleSource: override
      ? "override"
      : candidate.title
        ? "document"
        : "stored",
    context: candidate.context,
    operation: "publish",
  };
}

interface PublishedDocumentPublication {
  publicationId: string;
  record: DocumentPublicationRecord;
}

function documentPublicationOf(
  published: readonly ActivatedPublication[],
): PublishedDocumentPublication {
  for (const entry of published)
    if (entry.record.kind === "document")
      return { publicationId: entry.publicationId, record: entry.record };
  throw new Error("The activation committed no Review document publication.");
}

function mapPublicationOf(published: readonly ActivatedPublication[]): string {
  for (const entry of published)
    if (entry.record.kind === "map") return entry.publicationId;
  throw new Error("The activation committed no software map publication.");
}

/** The authoring tree the candidate was built from must still be on disk, or
 * the publication would present bytes no source produces. */
async function requireUnchangedAuthoring(
  reviewDir: string,
  candidate: PreparedDocumentCandidate,
): Promise<void> {
  if (
    candidate.authoringFingerprint !== (await fingerprintAuthoring(reviewDir))
  )
    throw new ReviewServerError(
      "Review authoring changed while preparing publication; rerun the publish command.",
      409,
      "review_authoring_changed",
    );
}

/** A session's bytes plus the review record they are presented under: a
 * publication restores the code context it was published against. */
interface PresentedSessionArtifact {
  review: StoredReview;
  artifact: ReviewSessionArtifactInput;
}

async function storedDocumentBundle(
  review: StoredReview,
  record: DocumentPublicationRecord,
): Promise<ReviewDocumentBundle | null> {
  if (record.artifact.state !== "stored") return null;
  return readReviewDocumentArtifact(review.dir, record.artifact.hash);
}

/** The map a historical document publication was published beside. */
async function historicalMapArtifact(
  review: StoredReview,
  publicationId: string | null,
): Promise<ReviewSessionArtifactMap | undefined> {
  if (!publicationId) return undefined;
  const row = readPublication(review.dir, publicationId, "map");
  const record = row ? parsePublicationRecord(row.record) : null;
  const bundle =
    record?.artifact.state === "stored"
      ? await readReviewSoftwareMapArtifact(review.dir, record.artifact.hash)
      : null;
  return bundle ? { bundle } : { unavailable: HISTORICAL_UNAVAILABLE_ERROR };
}

interface PresentedSoftwareMapArtifact {
  artifact: ReviewSessionArtifactMap | undefined;
  publicationId: string | null;
}

/** What the review presents as its software map: the stored bytes when a row
 * and an artifact answer the pointer, a message when either is missing, and
 * nothing at all when no map is published. */
async function presentedMapArtifact(
  review: StoredReview,
  staleMessage: string = NEEDS_REPUBLISH_MAP_ERROR,
): Promise<PresentedSoftwareMapArtifact> {
  const publicationId = review.review.presentedSoftwareMapRevision;
  if (!publicationId) return { artifact: undefined, publicationId: null };
  const row = readPublication(review.dir, publicationId, "map");
  const record = row ? parsePublicationRecord(row.record) : null;
  const bundle =
    record?.artifact.state === "stored"
      ? await readReviewSoftwareMapArtifact(review.dir, record.artifact.hash)
      : null;
  return bundle
    ? { artifact: { bundle }, publicationId }
    : { artifact: { unavailable: staleMessage }, publicationId: null };
}

/** An activation refusal carries its own status and machine code, so the JSON
 * routes hand those back instead of flattening every one of them to 400. */
function activationRefusal(
  error: Error,
):
  | ReviewActivationConflictError
  | ReviewMapPinsMismatchError
  | ReviewArtifactUnavailableError
  | undefined {
  return error instanceof ReviewActivationConflictError ||
    error instanceof ReviewMapPinsMismatchError ||
    error instanceof ReviewArtifactUnavailableError
    ? error
    : undefined;
}

function rejectTerminalPublication(review: StoredReviewRecord): void {
  if (review.status === "accepted" || review.status === "rejected") {
    throw new ReviewServerError(
      `Review ${review.uuid} is ${review.status}; publication pointers are frozen.`,
      409,
      "review_terminal",
    );
  }
}

/** The fast reject for a candidate prepared against a record that has since
 * moved. The activation's own guard is authoritative; this only avoids
 * mounting bytes that could never be committed. */
function rejectChangedReviewRecord(
  latest: StoredReview,
  expected: ExpectedReviewFields,
): void {
  if (
    reviewMutationFingerprint(latest.review) !==
    reviewMutationFingerprint(expected)
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
  await persistStoredReviewRecord(stored.dir, review);
  return { ...stored, review };
}

function httpJsonStatus(cause: unknown): number {
  return cause instanceof HttpJsonError ? cause.statusCode : 400;
}

function globalJson<T>(status: number, body: T): Response {
  // SAFETY: callers pass 2xx/4xx/5xx codes (literals, ReviewServerError and
  // HttpJsonError statusCode); none is a bodyless 1xx/204/205/304 status.
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
      if (!isTcpAddress(address)) {
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
    const current: JsonValue = JSON.parse(await readFile(filePath, "utf8"));
    if (
      isJsonObject(current) &&
      current.instanceId === discovery.instanceId &&
      current.appPid === discovery.appPid
    ) {
      await rm(filePath, { force: true });
    }
  } catch (error) {
    // SAFETY: fs/promises rejects with a Node ErrnoException carrying `code`.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** `server.address()` is a string for pipe and socket listeners. */
function isTcpAddress(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return isObjectValue(address);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
