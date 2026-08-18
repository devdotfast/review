import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type HttpBindings, getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { REVIEW_APP_SESSION_ID_HEADER } from "../ui-telemetry-events";
import { DEFAULT_MAX_REQUEST_BYTES, HttpJsonError } from "./http-json";

export type ReviewHonoEnv = {
  Bindings: HttpBindings;
};

export function createNodeRequestListener(
  app: Hono<ReviewHonoEnv>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return getRequestListener(app.fetch);
}

export function jsonResponse(
  body: unknown,
  status: ContentfulStatusCode,
  options: {
    cacheControl?: string;
    contentType?: string;
    newline?: boolean;
  } = {},
): Response {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json; charset=utf-8",
  });
  if (options.cacheControl) {
    headers.set("cache-control", options.cacheControl);
  }
  const serialized = JSON.stringify(body);
  return new Response(
    options.newline === false ? serialized : `${serialized}\n`,
    {
      status,
      headers,
    },
  );
}

export function applyCorsHeaders(
  request: Request,
  response: Response,
): Response {
  const origin = request.headers.get("origin");
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    const vary = response.headers.get("vary");
    const varyFields = vary
      ?.split(",")
      .map((field) => field.trim().toLowerCase());
    if (!varyFields?.includes("*") && !varyFields?.includes("origin")) {
      response.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
    }
  }
  response.headers.set(
    "access-control-allow-headers",
    `content-type, x-review-token, ${REVIEW_APP_SESSION_ID_HEADER}`,
  );
  response.headers.set(
    "access-control-allow-methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.headers.set("access-control-allow-private-network", "true");
  return response;
}

export function corsPreflightResponse(request: Request): Response {
  return applyCorsHeaders(request, new Response(null, { status: 204 }));
}

export function isAuthorizedRequest(
  request: Request,
  expectedToken: string,
): boolean {
  const supplied =
    request.headers.get("x-review-token") ??
    new URL(request.url).searchParams.get("token");
  if (!supplied) return false;
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

export async function readBoundedRequestJson(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BYTES,
  emptyValue?: unknown,
  options: { allowTextPlain?: boolean } = {},
): Promise<unknown> {
  assertJsonContentType(request, options);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw requestTooLarge(maxBytes);
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw requestTooLarge(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body && emptyValue !== undefined) return emptyValue;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpJsonError("Invalid JSON body.", 400);
  }
}

function assertJsonContentType(
  request: Request,
  options: { allowTextPlain?: boolean },
): void {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType !== "application/json" &&
    !mediaType?.endsWith("+json") &&
    !(options.allowTextPlain && mediaType === "text/plain")
  ) {
    throw new HttpJsonError("Content-Type must be application/json.", 415);
  }
}

function requestTooLarge(maxBytes: number): HttpJsonError {
  return new HttpJsonError(
    `Request body exceeds ${maxBytes === DEFAULT_MAX_REQUEST_BYTES ? "1 MiB" : `${maxBytes} bytes`}.`,
    413,
  );
}
