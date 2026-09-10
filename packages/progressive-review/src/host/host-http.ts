import {
  HOST_LIMITS,
  HOST_RESOURCE_LIMITS,
  type HostApiError,
  HostCommandSchema,
  HostDocumentValidationError,
  HostIdSchema,
  HostQuerySchema,
  isJsonObject,
} from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  type ReviewHonoEnv,
  readBoundedRequestJson,
} from "../server/hono-http";
import { HttpJsonError } from "../server/http-json";
import { EvidenceProviderError } from "./evidence-provider";
import { HostCredentials } from "./host-credentials";
import { type HostAccess, HostAccessError, ReviewHost } from "./review-host";
import { HostStoreError } from "./review-host-store";

type HostHttpEnv = ReviewHonoEnv & { Variables: { hostAccess: HostAccess } };

export interface HostHttpOptions {
  host: ReviewHost;
  credentials: HostCredentials;
  baseUrl: () => string;
  openReview: (reviewId: string) => Promise<void>;
}

/** Mounted on the existing desktop listener, before its legacy token middleware. */
export function createHostHttp(options: HostHttpOptions) {
  const app = new Hono<HostHttpEnv>();
  const { host, credentials } = options;
  const streams = new Set<() => void>();
  let closing = false;

  app.use("*", async (context, next) => {
    const expected = new URL(options.baseUrl());
    const request = context.req.raw;
    const origin = request.headers.get("origin");
    if (
      request.headers.get("host") !== expected.host ||
      (origin &&
        origin !== expected.origin &&
        origin !== "vscode-file://vscode-app")
    )
      return context.json(
        failure("FORBIDDEN", "Unexpected host or origin."),
        403,
      );
    const access = credentials.authenticate(
      request.headers.get("x-review-token") ?? undefined,
    );
    if (!access)
      return context.json(
        failure("UNAUTHORIZED", "A valid Review credential is required."),
        401,
      );
    if (closing)
      return context.json(
        failure("DEPENDENCY_UNAVAILABLE", "Review Desktop is shutting down."),
        503,
      );
    context.set("hostAccess", access);
    context.header("cache-control", "no-store");
    await next();
  });

  app.onError((error, context) => {
    const apiError = hostApiError(error);
    return context.json(
      { ok: false, error: apiError },
      errorStatus(apiError.code),
    );
  });

  app.get("/connection", (context) =>
    context.json({
      apiVersion: 1,
      hostId: host.store.hostId,
      workspaceId: host.store.workspaceId,
      principal: context.get("hostAccess").principal,
    }),
  );

  app.post("/workspaces/:workspaceId/commands", async (context) => {
    const request = HostCommandSchema.parse(
      await readBoundedRequestJson(
        context.req.raw,
        HOST_RESOURCE_LIMITS.assetUploadRequestBytes,
        undefined,
        {
          maxBytesForValue: (value) =>
            isJsonObject(value) && value.type === "asset.upload"
              ? HOST_RESOURCE_LIMITS.assetUploadRequestBytes
              : HOST_LIMITS.commandBytes,
        },
      ),
    );
    if (context.req.param("workspaceId") !== request.workspaceId)
      throw new HostAccessError("NOT_FOUND", "Workspace not found.");
    const response = await host.command(context.get("hostAccess"), request);
    return context.json({
      ok: true,
      data: { commandId: request.commandId, ...response },
    });
  });

  app.post("/workspaces/:workspaceId/queries", async (context) => {
    const request = HostQuerySchema.parse(
      await readBoundedRequestJson(context.req.raw, HOST_LIMITS.commandBytes),
    );
    if (context.req.param("workspaceId") !== request.workspaceId)
      throw new HostAccessError("NOT_FOUND", "Workspace not found.");
    const response = await host.query(context.get("hostAccess"), request);
    return context.json({ ok: true, data: response });
  });

  app.get("/workspaces/:workspaceId/events", (context) => {
    const after = z.string().min(1).max(2048).parse(context.req.query("after"));
    const reviewId = HostIdSchema.optional().parse(
      context.req.query("reviewId"),
    );
    const access = context.get("hostAccess");
    const workspaceId = context.req.param("workspaceId");
    // Authorize and validate the cursor before returning HTTP 200/SSE headers.
    host.events(access, workspaceId, after, reviewId);
    return streamSSE(context, async (output) => {
      let cursor = after;
      let stopped = false;
      let wake: (() => void) | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        wake?.();
        output.abort();
      };
      streams.add(stop);
      output.onAbort(stop);
      const unsubscribe = host.subscribe(() => wake?.());
      const unwatchCredential = credentials.onRevoked(
        context.req.header("x-review-token"),
        stop,
      );
      const heartbeat = setInterval(() => wake?.(), 15_000);
      heartbeat.unref?.();
      try {
        while (!stopped) {
          // Register the wake-up before reading. A commit during a slow write
          // therefore cannot be lost between catch-up and waiting.
          const changed = new Promise<void>((resolve) => {
            wake = resolve;
          });
          const events = host.events(access, workspaceId, cursor, reviewId);
          for (const event of events) {
            if (stopped) break;
            await output.writeSSE({
              id: event.cursor,
              data: JSON.stringify(event),
            });
            cursor = event.cursor;
          }
          if (events.length > 0) continue;
          await output.write(": ready\n\n");
          await changed;
        }
      } finally {
        unsubscribe();
        unwatchCredential();
        clearInterval(heartbeat);
        streams.delete(stop);
      }
    });
  });

  // This is a native-shell operation, deliberately outside the domain maps.
  app.post("/app/open", async (context) => {
    const access = context.get("hostAccess");
    const { reviewId } = z
      .strictObject({ reviewId: HostIdSchema })
      .parse(await readBoundedRequestJson(context.req.raw));
    if (!access.permissions.has("author") && access.principal.kind !== "human")
      throw new HostAccessError(
        "FORBIDDEN",
        "This credential cannot control the desktop window.",
      );
    if (access.reviewIds && !access.reviewIds.has(reviewId))
      throw new HostAccessError("NOT_FOUND", "Review not found.");
    host.store.review(reviewId);
    await options.openReview(reviewId);
    return context.json({ ok: true });
  });

  return {
    app,
    close() {
      closing = true;
      for (const stop of streams) stop();
    },
  };
}

function failure(code: HostApiError["code"], message: string) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      retryable: code === "DEPENDENCY_UNAVAILABLE",
      diagnostics: [],
    },
  };
}

export function hostApiError(error: Error): HostApiError {
  if (error instanceof HostDocumentValidationError)
    return {
      code: "VALIDATION_FAILED",
      message: error.message,
      retryable: false,
      diagnostics: error.diagnostics,
    };
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_REQUEST",
      message: "The request does not match the Review API schema.",
      retryable: false,
      diagnostics: error.issues.slice(0, 100).map((issue) => ({
        severity: "error",
        code: issue.code,
        message: issue.message,
        path: `/${issue.path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`,
      })),
    };
  if (
    error instanceof HostStoreError ||
    error instanceof HostAccessError ||
    error instanceof EvidenceProviderError
  )
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "DEPENDENCY_UNAVAILABLE",
      diagnostics: [],
    };
  if (error instanceof HttpJsonError)
    return {
      code: error.statusCode === 413 ? "RESOURCE_LIMIT" : "INVALID_REQUEST",
      message: error.message,
      retryable: false,
      diagnostics: [],
    };
  return {
    code: "INTERNAL",
    message: "The host could not complete this operation.",
    retryable: false,
    diagnostics: [],
  };
}

function errorStatus(code: HostApiError["code"]): ContentfulStatusCode {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "CURSOR_EXPIRED":
    case "INVALID_STATE":
      return 409;
    case "RESOURCE_LIMIT":
      return 413;
    case "VALIDATION_FAILED":
      return 422;
    case "RATE_LIMITED":
      return 429;
    case "DEPENDENCY_UNAVAILABLE":
      return 503;
    case "INTERNAL":
    case "INTEGRITY_ERROR":
      return 500;
    default:
      return 400;
  }
}
