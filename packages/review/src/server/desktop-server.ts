import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type JsonObject,
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewCliInstallApplyResponse,
  type ReviewDescriptor,
  type ReviewDesktopDiscovery,
  type ReviewDesktopGlobalEvent,
  type ReviewRecord,
  type ReviewSessionDescriptor,
  type ReviewSessionWire,
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
import { errorMessage, writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { parseAuthoringSessionKey } from "../agent-session-ref";
import {
  applyCliInstall,
  declineCliInstall,
  removeCliInstall,
  resetCliInstall,
  resolveCliInstallStatus,
  skipCliInstall,
} from "../cli-install";
import { readReviewPackageVersion } from "../package-paths";
import {
  materializePublishRevision,
  reviewWithPresentedDocumentPins,
} from "../publish-stage";
import { ReviewInputError } from "../review-api/document.js";
import { createReviewApi } from "../review-api/http.js";
import type { LocalReviewData } from "../review-api/local-data.js";
import type { ReviewStore } from "../review-api/store.js";
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
  ReviewHomeScanError,
  type StoredReview,
  type StoredReviewRecord,
  findReview,
  findReviewForRepair,
  listReviews,
  parseAnyStoredReviewRecord,
  reviewDescriptor,
  reviewsHomeDir,
} from "../review-home";
import { reviewDesktopDiscoveryPath } from "../review-home-paths";
import { devReviewHome } from "../review-home-paths";
import type { LegacyImporter } from "../review-import/legacy-importer";
import type { RunReviewInfoInput } from "../review-info";
import { resolveReviewInfo } from "../review-info-resolver";
import {
  ReviewBusyError,
  reviewBusyResponse,
  reviewMutationFingerprint,
  withReviewMutationLock,
} from "../review-mutation-lock";
import {
  readReviewPreferences,
  writeReviewPreferences,
} from "../review-preferences";
import {
  type ReviewSessionAgent,
  type ReviewSessionOutcome,
  type ReviewSourceKind,
  ReviewTelemetry,
} from "../review-telemetry";
import {
  REVIEW_APP_SESSION_ID_HEADER,
  isValidReviewAppSessionId,
} from "../ui-telemetry-events";
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
import { createJsonReviewReporting } from "./json-review-reporting";
import { captureSanitizedUiTelemetry } from "./review-api";
import {
  type ReviewSessionHandler,
  createReviewSessionHandler,
} from "./session-handler";
import { createTutorialService } from "./tutorial-service";

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
  terminal: boolean;
  closing: boolean;
  telemetryStarted: boolean;
  telemetryEnded: boolean;
  appSessionId?: string;
  tutorialPreparation?: PreparedTutorial;
}

interface RegisterSessionInput {
  review: StoredReview;
  /** Live record observed before preparing the sealed presentation. */
  canonicalRecord: StoredReviewRecord;
  documentPath: string;
  softwareMapRootPath?: string;
  revision?: string;
  historicalRevision?: string;
  documentUnavailable?: string;
  softwareMapUnavailable?: string;
  repairValidation?: boolean;
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
  canonicalRecord: StoredReviewRecord;
  documentPath: string;
  softwareMapRootPath: string;
  checkoutRoots: ReviewCheckoutRoots;
}

export interface GlobalReviewServerInput {
  /** The desktop host owns this shared database and closes it after the server. */
  reviewStore?: ReviewStore;
  reviewData?: LocalReviewData;
  appPid: number;
  packageRoot: string;
  toolingRoot: string;
  cliRuntimePath?: string;
  port: number;
  token?: string;
  instanceId?: string;
  discoveryPath?: string;
  sessionHandlerFactory?: typeof createReviewSessionHandler;
  pinnedCheckoutFactory?: typeof ensureReviewPinnedCheckout;
  publishRuntime?: {
    materializePublishRevision: typeof materializePublishRevision;
  };
  telemetry?: ReviewTelemetry;
  /* Object seam, like publishRuntime: a test supplies a relay whose dispatch
     it controls instead of reaching into the class. */
  relay?: ReviewDesktopVerbRelay;
  /** Legacy import seam; the default imports into `reviewStore`. */
  legacyImporter?: LegacyImporter;
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

  const publishRuntime = input.publishRuntime ?? {
    materializePublishRevision,
  };

  const telemetry = input.telemetry ?? ReviewTelemetry.fromEnv();
  const relay = input.relay ?? new GlobalReviewDesktopVerbRelay();
  const sessions = new Map<string, ActiveReviewSession>();
  const reviewStore = input.reviewStore;

  // Production completes its storage migration before constructing the host.
  const legacyImporter = input.legacyImporter;

  function migratedError(uuid: string, verb: string): ReviewServerError {
    return new ReviewServerError(
      `Review ${uuid} was migrated to the JSON review store. \`review ${verb}\` no longer applies; edit it with \`review api\` or the Review MCP tools.`,
      409,
      "migrated",
    );
  }

  const reviewLocks = new Map<string, Promise<void>>();
  const globalClients = new Set<ReviewDesktopEventClient>();

  const tutorial = createTutorialService({
    packageRoot: input.packageRoot,
    deleteReview: deleteStoredReview,
  });

  let preparedTutorial: PreparedTutorial | null = null;
  let reviewReaper: ReturnType<typeof setInterval> | undefined;
  let closing = false;
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
    discovery.cliVersion = readReviewPackageVersion(
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

  if (input.reviewStore)
    app.route(
      "/reviews-api",
      createJsonReviewReporting(input.reviewStore, telemetry),
    );

  if (input.reviewStore)
    app.route(
      "/reviews-api",
      createReviewApi(input.reviewStore, input.reviewData, async (review) => {
        const result = await relay.dispatch("review-desktop", {
          name: "openApiReview",
          args: review,
        });

        if (!result.ok) throw new ReviewInputError(result.error, 409);

        return z
          .object({ softwareMapEnabled: z.boolean() })
          .parse(result.result);
      }),
    );
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
    if (reviewStore) return globalJson(200, { reviews: [], errors: [] });
    const { dismissedRetentionDays } = await readReviewPreferences();
    await reapDismissedReviews(dismissedRetentionDays);
    const listed = await listReviews();
    void legacyImporter?.sweep(listed.reviews);

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
    if (reviewStore && !(await tutorial.referencesReview(uuid))) {
      if (!reviewStore.has(uuid))
        throw new ReviewServerError(
          "Review is not in the JSON store. Inspect the JSON migration report; legacy sessions are retired.",
          404,
          "review_unavailable",
        );
      const snapshot = reviewStore.read(uuid);

      const opened = await relay.dispatch("review-desktop", {
        name: "openApiReview",
        args: { reviewId: uuid, title: snapshot.title },
      });

      if (!opened.ok)
        throw new ReviewServerError(
          opened.error ?? "Desktop unavailable",
          503,
          "desktop_unavailable",
        );
      throw new ReviewServerError(
        "Review opened in the JSON canvas.",
        409,
        "imported",
      );
    }

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

    // Import before opening: an imported review lives in the JSON canvas.
    const imported = legacyImporter
      ? await legacyImporter.ensure(review)
      : null;

    if (imported && imported.kind !== "skipped") {
      if (reviewStore && !reviewStore.has(uuid))
        throw new ReviewServerError(
          "This review was imported into the JSON review store and then deleted there.",
          404,
          "deleted",
        );

      const opened = await relay.dispatch("review-desktop", {
        name: "openApiReview",
        args: { reviewId: uuid, title: review.review.title },
      });

      if (!opened.ok)
        throw new ReviewServerError(
          `Review Desktop could not open the imported review: ${opened.error ?? "unknown error"}`,
          503,
          "desktop_unavailable",
        );
      throw new ReviewServerError(
        "Review opened in the JSON canvas.",
        409,
        "imported",
      );
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

    let documentUnavailable: string | undefined;

    const documentBuildDir = await publishRuntime
      .materializePublishRevision({
        review: viewed,
        revision: documentRevision,
      })
      .catch(() => {
        documentUnavailable = `The presented document revision ${documentRevision} is unavailable.`;

        return path.join(review.dir, ".build", documentRevision);
      });

    const presentedReview = documentUnavailable
      ? viewed
      : await reviewWithPresentedDocumentPins(viewed, documentBuildDir);

    let softwareMapUnavailable: string | undefined;

    const softwareMapRootPath = viewed.review.presentedSoftwareMapRevision
      ? await publishRuntime
          .materializePublishRevision({
            review: viewed,
            revision: viewed.review.presentedSoftwareMapRevision,
          })
          .then((root) => presentedMapRoot(root, false))
          .catch(() => {
            softwareMapUnavailable = `The presented software map revision ${viewed.review.presentedSoftwareMapRevision} is unavailable.`;

            return undefined;
          })
      : undefined;

    const active = await registerSerialized({
      review: presentedReview,
      canonicalRecord: viewed.review,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      documentUnavailable,
      softwareMapUnavailable,
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

    const presentedValue = JSON.parse(
      await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
    );

    const presentedRecord = parseAnyStoredReviewRecord(presentedValue);

    const presentedReview = await reviewWithPresentedDocumentPins(
      review,
      documentBuildDir,
      presentedRecord,
    );

    let softwareMapUnavailable: string | undefined;

    const softwareMapRootPath = presentedRecord.presentedSoftwareMapRevision
      ? await publishRuntime
          .materializePublishRevision({
            review,
            revision: presentedRecord.presentedSoftwareMapRevision,
          })
          .then((root) =>
            presentedMapRoot(root, presentedValue.schemaVersion === 2),
          )
          .catch(() => {
            softwareMapUnavailable = `The historical software map revision ${presentedRecord.presentedSoftwareMapRevision} is unavailable.`;

            return undefined;
          })
      : undefined;

    const active = await registerSerialized({
      review: presentedReview,
      canonicalRecord: review.review,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      promoted: false,
      historicalRevision: revision,
      softwareMapUnavailable,
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
    if (reviewStore)
      return globalJson(
        200,
        await reviewStore.execute({
          commandId: crypto.randomUUID(),
          operation: {
            type: "attention",
            reviewId: context.req.param("uuid"),
            action: "dismiss",
          },
        }),
      );

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
    if (reviewStore)
      return globalJson(
        200,
        await reviewStore.execute({
          commandId: crypto.randomUUID(),
          operation: {
            type: "attention",
            reviewId: context.req.param("uuid"),
            action: "restore",
          },
        }),
      );

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
      (await tutorial.referencesReview(uuid));

    if (referencesTutorial) {
      await withReviewLock(TUTORIAL_LIFECYCLE_LOCK_KEY, async () => {
        const stillReferencesTutorial =
          preparedTutorial?.review.review.uuid === uuid ||
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
    } else if (reviewStore) {
      await reviewStore.execute({
        commandId: crypto.randomUUID(),
        operation: { type: "delete", reviewId: uuid },
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

    if (busyError) return globalJson(409, reviewBusyResponse(busyError));

    const serverError = error instanceof ReviewServerError ? error : undefined;

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
    const cached = await validPreparedTutorial();

    if (cached) return cached;
    const prepared = await prepareTutorialLocally();
    preparedTutorial = prepared;

    return prepared;
  }

  async function validPreparedTutorial(): Promise<PreparedTutorial | null> {
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
      !pathsExist
    ) {
      preparedTutorial = null;
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
    cached.canonicalRecord = current.review;

    return cached;
  }

  /* The Welcome page invokes only this local preparation path: materialize the
     shipped Review and warm both managed Git checkouts. */
  async function prepareTutorialLocally(): Promise<PreparedTutorial> {
    const startedAt = Date.now();

    const review = await tutorial.prepare({
      beforeReset: async () => {
        preparedTutorial = null;
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
      canonicalRecord: review.review,
      documentPath: path.join(documentBuildDir, "review.mdx"),
      softwareMapRootPath,
      checkoutRoots,
    };
  }

  /* Open mounts the already-prepared artifacts immediately. */
  async function openTutorialLocked(): Promise<ReviewTutorialOpenResponse> {
    const prepared = await prepareTutorialLocked();
    let existing = activeSessionForReview(prepared.review.review.uuid);

    if (existing && existing.tutorialPreparation !== prepared) {
      await closeSession(existing, "replaced", false);
      existing = undefined;
    }

    if (existing) {
      void relay.dispatch(existing.descriptor.sessionId, {
        name: "focusCanvas",
        args: {},
      });
    }

    const session =
      existing ??
      (await registerSerialized({
        review: prepared.review,
        canonicalRecord: prepared.canonicalRecord,
        documentPath: prepared.documentPath,
        softwareMapRootPath: prepared.softwareMapRootPath,
        checkoutRoots: prepared.checkoutRoots,
        tutorialPreparation: prepared,
        promoted: true,
        focusCanvas: true,
      }));

    return {
      reviewUuid: session.review.review.uuid,
      sessionId: session.descriptor.sessionId,
      url: session.descriptor.sessionUrl,
      review: await reviewDescriptor(session.review),
      session: session.descriptor,
    };
  }

  async function deleteTutorialLocked(): Promise<void> {
    preparedTutorial = null;
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
    broadcastGlobal({ event: "review-deleted", uuid: review.review.uuid });
  }

  async function registerSerialized(
    registration: RegisterSessionInput,
  ): Promise<ActiveReviewSession> {
    const expected = reviewMutationFingerprint(registration.canonicalRecord);
    const prepared = await prepareSession(registration);
    let installed = false;

    try {
      const active = await withReviewLock(
        registration.review.review.uuid,
        async () => {
          assertServerOpen();

          const latest = await findReviewForRepair(
            registration.review.review.uuid,
          );

          if (
            !latest ||
            reviewMutationFingerprint(latest.review) !== expected
          ) {
            throw new ReviewServerError(
              "Review changed while preparing its session; retry opening or publishing it.",
              409,
              "review_changed",
            );
          }

          const existing = matchingSession(registration);

          if (existing) return existing;
          sessions.set(prepared.descriptor.sessionId, prepared);
          installed = true;

          return prepared;
        },
      );

      if (!installed) return active;
      await startSessionTelemetry(active).catch((error) =>
        console.error("Could not start Review session telemetry:", error),
      );

      if (registration.announce) {
        const event: ReviewDesktopGlobalEvent = {
          event: "session-registered",
          session: active.descriptor,
        };

        if (registration.background) event.background = true;
        broadcastGlobal(event);
      }

      if (registration.focusCanvas)
        void relay.dispatch(
          active.descriptor.sessionId,
          revealVerb(registration.view),
        );

      return active;
    } finally {
      if (!installed) await prepared.handler.close();
    }
  }

  function assertServerOpen(): void {
    if (closing)
      throw new ReviewServerError(
        "Review Desktop is closing.",
        409,
        "server_closing",
      );
  }

  function matchingSession(
    registration: RegisterSessionInput,
  ): ActiveReviewSession | undefined {
    return [...sessions.values()].find(
      (session) =>
        !session.closing &&
        session.review.review.uuid === registration.review.review.uuid &&
        ((registration.promoted && session.promoted) ||
          (registration.historicalRevision !== undefined &&
            session.historicalRevision === registration.historicalRevision)),
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

    const baseRootPath = await (
      input.pinnedCheckoutFactory ?? ensureReviewPinnedCheckout
    )({
      rootPath: review.review.worktreePath,
      ref: review.review.baseCommit,
      reviewUuid: review.review.uuid,
      role: "base",
    });

    const headRootPath = await (
      input.pinnedCheckoutFactory ?? ensureReviewPinnedCheckout
    )({
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

  /** Pinned checkouts and handler creation perform no review mutation. */
  async function prepareSession(
    registration: RegisterSessionInput,
  ): Promise<ActiveReviewSession> {
    assertServerOpen();
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

    const sourceCommit =
      registration.source?.sourceCommit ??
      registration.review.review.sourceCommit;

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
      registration.documentPath,
      registration.source,
      baseRootPath,
      headRootPath,
    );

    let active!: ActiveReviewSession;

    const handler = await sessionHandlerFactory({
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
      artifacts: {
        document: registration.documentUnavailable,
        map: registration.softwareMapUnavailable,
        source: sourceUnavailable,
      },
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
      onReviewDismiss: () => onReviewDismiss(active),
      onReviewDataChange: () => {
        broadcastGlobal({
          event: "review-data-changed",
          uuid: registration.review.review.uuid,
          sessionId,
        });
      },
      telemetry,
    });

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
      terminal: false,
      closing: false,
      telemetryStarted: false,
      telemetryEnded: false,
      appSessionId: registration.appSessionId,
      tutorialPreparation: registration.tutorialPreparation,
    };

    return active;
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
    // The original directories are migration archives after the JSON cutover.
    if (reviewStore || retentionDays === null) return;
    const listed = await listReviews().catch(() => null);

    if (!listed) return;

    for (const stored of selectReapableReviews(listed.reviews, retentionDays)) {
      const { uuid } = stored.review;

      // A review that is open must not vanish under the reader.
      if (activeSessionForReview(uuid)) continue;

      try {
        await withReviewLock(uuid, async () => {
          await rm(stored.dir, { recursive: true, force: true });
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
    outcome: ReviewSessionOutcome,
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
      await Promise.all(
        [...sessions.values()].map((session) =>
          closeSession(session, "app-exit", false).catch(() => undefined),
        ),
      );
      relay.close();

      for (const client of globalClients) client.close();
      globalClients.clear();
      await closeHttpServer(httpServer);
      await telemetry.shutdown(1_500);
    },
  };
}

function reviewSourceKind(review: ReviewRecord): ReviewSourceKind {
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
): ReviewSessionAgent {
  const sessionKey =
    latestAgentSessionWithRole(review, "publisher") ??
    latestAgentSessionWithRole(review, "author") ??
    review.sourceSession;

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
  documentPath: string,
  source?: ActiveReviewSession["source"],
  baseRootPath?: string,
  headRootPath?: string,
): ReviewSessionWire {
  const headRef = source?.sourceCommit ?? review.review.sourceCommit;

  if (!headRef && !descriptor.historicalRevision) {
    throw new ReviewServerError(
      `Review ${review.review.uuid} is not bound to a source commit.`,
      409,
      "review_unbound",
    );
  }

  const authoringAgent = parseAuthoringSessionKey(review.review.sourceSession);

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
    reviewPath: documentPath,
    agent: authoringAgent,
    startedAt: descriptor.startedAt,
  };

  if (descriptor.historicalRevision) {
    wire.historicalRevision = descriptor.historicalRevision;
  }

  return wire;
}

async function presentedMapRoot(
  root: string,
  allowAbsent: boolean,
): Promise<string | undefined> {
  if (!allowAbsent) return root;

  try {
    await stat(path.join(root, ".bundle", "software-map"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }

  return root;
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
