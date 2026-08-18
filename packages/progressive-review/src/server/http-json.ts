import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export class HttpJsonError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "HttpJsonError";
  }
}

export async function readBoundedJson(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_REQUEST_BYTES,
  emptyValue?: unknown,
): Promise<unknown> {
  assertJsonContentType(request);
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpJsonError(
      `Request body exceeds ${formatByteLimit(maxBytes)}.`,
      413,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpJsonError(
        `Request body exceeds ${formatByteLimit(maxBytes)}.`,
        413,
      );
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body && emptyValue !== undefined) return emptyValue;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpJsonError("Invalid JSON body.", 400);
  }
}

function assertJsonContentType(request: IncomingMessage): void {
  const raw = request.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
    throw new HttpJsonError("Content-Type must be application/json.", 415);
  }
}

function formatByteLimit(maxBytes: number): string {
  return maxBytes === 1024 * 1024 ? "1 MiB" : `${maxBytes} bytes`;
}
