import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { jsonString } from "@dev.fast/json";
import {
  type JsonObject,
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewCliInstallApplyResponse,
  type ReviewDesktopDiscovery,
  type ReviewTutorialOpenResponse,
  isJsonObject,
  isObjectValue,
  parseReviewCliInstallApplyRequest,
  reviewDiffrSummarizerInputSchema,
} from "@dev.fast/review-protocol";
import {
  traceMachineEnabled,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  applyCliInstall,
  declineCliInstall,
  finishCliInstallUpdate,
  removeCliInstall,
  removeLegacyReviewSkills,
  resetCliInstall,
  resolveCliInstallStatus,
  skipCliInstall,
} from "../cli-install";
import type { ReviewInstanceIdentity } from "../desktop-discovery";
import { readReviewPackageVersion } from "../package-paths";
import { ReviewInputError } from "../review-api/document.js";
import { createReviewApi } from "../review-api/http.js";
import type { LocalReviewData } from "../review-api/local-data.js";
import type { ReviewStore } from "../review-api/store.js";
import {
  devReviewHome,
  reviewInstanceDiscoveryPath,
  reviewLegacyDiscoveryPath,
} from "../review-home-paths";
import {
  readScratchpadEnabled,
  writeScratchpadEnabled,
} from "../review-preferences";
import { ReviewTelemetry } from "../review-telemetry";
import type { SharedReviewStore } from "../sharing/import.js";
import {
  readDiffrConfig,
  saveDiffrSummarizer,
  setDiffrConfigValue,
  testDiffrSummarizer,
} from "./diffr-config";
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
import { createTutorialService } from "./tutorial-service";
import { captureSanitizedUiTelemetry } from "./ui-telemetry";

const TUTORIAL_LIFECYCLE_LOCK_KEY = "tutorial-lifecycle";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GlobalReviewServerInput {
  /** The desktop host owns this shared database and closes it after the server. */
  reviewStore: ReviewStore;
  sharedReviews?: SharedReviewStore;
  reviewData: LocalReviewData;
  appPid: number;
  packageRoot: string;
  toolingRoot: string;
  cliRuntimePath?: string;
  port: number;
  token?: string;
  instanceId?: string;
  identity?: ReviewInstanceIdentity;
  discoveryPath?: string;
  telemetry?: ReviewTelemetry;
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
  const identity = input.identity ?? { key: "stable", channel: "stable" };

  // Stable also writes the pre-instance server.json, so a CLI or shim that
  // predates instances still finds it.
  const discoveryPaths = input.discoveryPath
    ? [input.discoveryPath]
    : identity.key === "stable"
      ? [reviewInstanceDiscoveryPath("stable"), reviewLegacyDiscoveryPath()]
      : [reviewInstanceDiscoveryPath(identity.key)];

  const telemetry = input.telemetry ?? ReviewTelemetry.fromEnv();
  const relay = input.relay ?? new GlobalReviewDesktopVerbRelay();
  const reviewStore = input.reviewStore;

  const reviewLocks = new Map<string, Promise<void>>();

  const tutorial = createTutorialService({
    packageRoot: input.packageRoot,
    store: reviewStore,
    data: input.reviewData,
  });

  let closing = false;
  const cliPath = path.join(input.packageRoot, "dist", "cli.js");

  // The scratchpad preference, read once at listen and kept current by the
  // settings endpoint below: this server is the only writer while it runs.
  let scratchpadEnabled = false;

  const discovery: ReviewDesktopDiscovery = {
    version: REVIEW_DESKTOP_DISCOVERY_VERSION,
    instanceId,
    url: urlForBoundPort(),
    appPid: input.appPid,
    serverPid: process.pid,
    token,
    startedAt: Date.now(),
    ...identity,
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

  app.route(
    "/reviews-api",
    createJsonReviewReporting(input.reviewStore, telemetry, {
      shared: input.sharedReviews,
    }),
  );

  app.route(
    "/reviews-api",
    createReviewApi(
      input.reviewStore,
      input.reviewData,
      async (review) => {
        const result = await relay.dispatch({
          name: "openApiReview",
          args: review,
        });

        if (!result.ok) throw new ReviewInputError(result.error, 409);

        return z
          .object({ softwareMapEnabled: z.boolean() })
          .parse(result.result);
      },
      input.sharedReviews,
      async () => {
        if (!relay.attached)
          return { desktopAvailable: false, softwareMapEnabled: false };

        const result = await relay.dispatch({
          name: "authoringCapabilities",
          args: {},
        });

        if (!result.ok) throw new ReviewInputError(result.error, 409);

        return {
          desktopAvailable: true,
          ...z.object({ softwareMapEnabled: z.boolean() }).parse(result.result),
        };
      },
      () => scratchpadEnabled,
      () => traceMachineEnabled(),
      () => {
        const { key, channel, checkout, appVersion, cliVersion, instanceId } =
          discovery;

        return {
          key: key ?? null,
          channel: channel ?? null,
          checkout: checkout ?? null,
          appVersion: appVersion ?? null,
          cliVersion: cliVersion ?? null,
          instanceId,
          url: urlForBoundPort(),
          home: devReviewHome(),
        };
      },
    ),
  );
  app.get("/preferences/scratchpad", () =>
    globalJson(200, { enabled: scratchpadEnabled }),
  );
  app.put("/preferences/scratchpad", async (context) => {
    const request = z
      .object({ enabled: z.boolean() })
      .safeParse(await readBoundedRequestJson(context.req.raw));

    if (!request.success)
      throw new ReviewServerError("enabled must be a boolean.", 400);

    scratchpadEnabled = await writeScratchpadEnabled(request.data.enabled);

    // Home watches the catalog; the pad appears or goes without a store write.
    if (scratchpadEnabled) await reviewStore.ensureScratchpad();
    reviewStore.invalidateCatalog();

    return globalJson(200, { enabled: scratchpadEnabled });
  });
  app.post("/app/focus", async () => {
    const result = await relay.dispatch({
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
      reviewUuid: prepared.reviewId,
    });
  });
  // The tutorial descriptor is not in `GET /reviews`, so tooling and
  // integration checks fetch it here.
  app.get("/tutorial/review", async () => {
    const stored = await tutorial.find();

    if (!stored) {
      throw new ReviewServerError("Review not found.", 404);
    }

    return globalJson(200, {
      reviewId: stored.reviewId,
      title: stored.title,
      pins: stored.pins,
      version: stored.version,
    });
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
  app.get("/diffr-config", async () =>
    globalJson(200, await readDiffrConfig()),
  );
  app.put("/diffr-config", async (context) => {
    const body = await readBoundedRequestJson(context.req.raw);

    const key = isJsonObject(body) ? jsonString(body.key) : undefined;

    const value = isJsonObject(body) ? body.value : undefined;

    if (key === undefined || value === undefined) {
      throw new ReviewServerError("key and value are required.", 400);
    }

    return globalJson(200, await setDiffrConfigValue(key, value));
  });
  app.put("/diffr-config/summarizer", async (context) => {
    const input = reviewDiffrSummarizerInputSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!input.success)
      throw new ReviewServerError("Invalid summary settings.", 400);

    return globalJson(200, await saveDiffrSummarizer(input.data));
  });
  app.post("/diffr-config/summarizer/test", async (context) => {
    const input = reviewDiffrSummarizerInputSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!input.success)
      throw new ReviewServerError("Invalid summary settings.", 400);

    return globalJson(200, {
      summary: await testDiffrSummarizer(
        input.data,
        undefined,
        context.req.raw.signal,
      ),
    });
  });
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
    };

    if (request.shim !== undefined) applyInput.shim = request.shim;

    if (request.autoUpdate) applyInput.autoUpdate = true;

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

    const removeInput: Parameters<typeof removeCliInstall>[0] = {};

    if (request.shim) removeInput.shim = true;

    if (request.trace) removeInput.trace = true;
    const result = await removeCliInstall(removeInput);

    return globalJson(200, { ok: true, output: result.output });
  });
  app.post("/install/legacy-skills/remove", async () => {
    const { removed } = await removeLegacyReviewSkills();

    return globalJson(200, { ok: true, removed });
  });
  app.post("/install/finish-update", async () => {
    await finishCliInstallUpdate();

    return globalJson(200, { ok: true });
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
  app.get("/control", (context) => openControlEvents(context));
  app.post("/control/result", async (context) => {
    const accepted = relay.acceptResult(
      await readBoundedRequestJson(context.req.raw),
    );

    return globalJson(accepted ? 200 : 404, { ok: accepted });
  });
  app.notFound(() => globalJson(404, { ok: false, error: "Not found." }));
  app.onError((error) => {
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

  async function prepareTutorialLocked() {
    return tutorial.prepare();
  }

  async function openTutorialLocked(): Promise<ReviewTutorialOpenResponse> {
    const snapshot = await prepareTutorialLocked();

    return {
      kind: "api",
      reviewUuid: snapshot.reviewId,
      title: snapshot.title,
    };
  }

  async function deleteTutorialLocked(): Promise<void> {
    await tutorial.cleanup();
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

  return {
    discovery,
    get url() {
      return urlForBoundPort();
    },
    listen: async () => {
      scratchpadEnabled = await readScratchpadEnabled();
      boundPort = await listen(httpServer, input.port);
      discovery.url = urlForBoundPort();

      for (const discoveryPath of discoveryPaths)
        await writePrivateJsonAtomic(discoveryPath, discovery);
    },
    close: async () => {
      if (closing) return;
      closing = true;

      for (const discoveryPath of discoveryPaths)
        await removeMatchingDiscovery(discoveryPath, discovery);
      relay.close();

      await closeHttpServer(httpServer);
      await telemetry.shutdown(1_500);
    },
  };
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
