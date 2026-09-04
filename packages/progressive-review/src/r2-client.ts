import { createHash, createHmac } from "node:crypto";

import { span } from "./startup-trace";

/**
 * In-process S3-compatible client for the trace bucket (Cloudflare R2),
 * signing requests with SigV4 over `fetch`. It replaces one `aws` CLI spawn
 * per object operation (~0.5–1s each) with a plain HTTPS round-trip.
 */
export interface R2ClientConfig {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(bucket: string, key: string): string {
  return `/${encodePathSegment(bucket)}/${key.split("/").map(encodePathSegment).join("/")}`;
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodePathSegment(k)}=${encodePathSegment(query[k])}`)
    .join("&");
}

function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { stamp: iso, date: iso.slice(0, 8) };
}

export interface R2Response {
  status: number;
  headers: Headers;
  body: Buffer;
}

export async function r2Request(
  config: R2ClientConfig,
  input: {
    method: "GET" | "HEAD" | "PUT";
    key: string;
    query?: Record<string, string>;
    body?: Buffer;
    contentType?: string;
    timeoutMs?: number;
  },
): Promise<R2Response> {
  const endpoint = new URL(config.endpoint);
  const pathName = canonicalPath(config.bucket, input.key);
  const query = input.query ?? {};
  const url = new URL(`${endpoint.origin}${pathName}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const payloadHash = input.body ? sha256Hex(input.body) : EMPTY_SHA256;
  const { stamp, date } = amzDate(new Date());
  const headers: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (input.contentType) headers["content-type"] = input.contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    input.method,
    pathName,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, date), REGION), SERVICE),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const { host: _host, ...requestHeaders } = headers;
  const label = `r2 ${input.method} ${input.key}${input.query?.prefix ? ` prefix=${input.query.prefix}` : ""}`;
  return span(label, async () => {
    const response = await fetch(url, {
      method: input.method,
      headers: { ...requestHeaders, authorization },
      body: input.body ? new Uint8Array(input.body) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body };
  });
}

/** Object size, or null when it does not exist. Other failures throw. */
export async function r2HeadSize(
  config: R2ClientConfig,
  key: string,
): Promise<number | null> {
  const response = await r2Request(config, {
    method: "HEAD",
    key,
    timeoutMs: 10_000,
  });
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`R2 HEAD ${key} returned ${response.status}.`);
  }
  const length = response.headers.get("content-length");
  return length ? Number.parseInt(length, 10) : null;
}

/** Object bytes, or null when it does not exist. Other failures throw. */
export async function r2GetBytes(
  config: R2ClientConfig,
  key: string,
): Promise<Buffer | null> {
  const response = await r2Request(config, { method: "GET", key });
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`R2 GET ${key} returned ${response.status}.`);
  }
  return response.body;
}

export async function r2PutBytes(
  config: R2ClientConfig,
  key: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  const response = await r2Request(config, {
    method: "PUT",
    key,
    body,
    contentType,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`R2 PUT ${key} returned ${response.status}.`);
  }
}

/** Keys under a prefix (ListObjectsV2, one level when `delimiter` is set). */
export async function r2ListKeys(
  config: R2ClientConfig,
  prefix: string,
  options: { delimiter?: string } = {},
): Promise<{ keys: string[]; prefixes: string[] }> {
  const keys: string[] = [];
  const prefixes: string[] = [];
  let continuation: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (options.delimiter) query.delimiter = options.delimiter;
    if (continuation) query["continuation-token"] = continuation;
    const response = await r2Request(config, { method: "GET", key: "", query });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`R2 LIST ${prefix} returned ${response.status}.`);
    }
    const xml = response.body.toString("utf8");
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g))
      keys.push(decodeXml(match[1]));
    for (const match of xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)) {
      const value = decodeXml(match[1]);
      if (value !== prefix) prefixes.push(value);
    }
    const token =
      /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    continuation = token ? decodeXml(token[1]) : undefined;
  } while (continuation);
  return { keys, prefixes };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
