// Transport for the hosted trace store.
//
// The CLI ships a session as gzipped objects through presigned S3 URLs and
// reads them back the same way. The HTTP transport talks to the real store.
// Tests use the separate memory transport so they never open a socket; both
// transports verify every download the same way before a caller may read it.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";

import {
  type BeginUploadRequest,
  type BeginUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type PresignedUpload,
  type StoredObject,
} from "@dev.fast/trace-protocol";

import { StoreApiError, type StoreClient } from "./store-client";

/** An object response failed. Its URL is deliberately not retained. */
export class TraceObjectHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One presigned upload from `beginUpload`. */
export type TraceStoreUpload = PresignedUpload;

/** One session as the store lists it, with presigned download URLs. */
export type TraceStoreSession = ListSessionsResponse["sessions"][number];

/**
 * How long one object transfer may take. The contract caps an object at
 * 256 MiB; at 1 MB/s that transfer needs a little over four minutes. A
 * pre-push hook must not wait longer than this on a stalled connection.
 */
export const TRACE_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The most bytes one download may expand to. Observed alpha transcripts are
 * at most about 20 MB raw and gzip shrinks them 5 to 10 times. The contract
 * caps a compressed object at 256 MiB, so 1 GiB leaves room for a dense
 * transcript while a small object can never fill the disk.
 */
export const MAX_TRACE_EXPANDED_BYTES = 1024 * 1024 * 1024;

export interface TraceTransferLimits {
  timeoutMs: number;
  maxExpandedBytes: number;
}

export const DEFAULT_LIMITS: TraceTransferLimits = {
  timeoutMs: TRACE_TRANSFER_TIMEOUT_MS,
  maxExpandedBytes: MAX_TRACE_EXPANDED_BYTES,
};

export interface TraceStoreTransportOptions {
  /** Tests lower these to exercise the bounds. */
  limits?: Partial<TraceTransferLimits>;
}

export interface TraceStoreTransport {
  beginUpload(
    repositoryId: number,
    sessionId: string,
    body: BeginUploadRequest,
  ): Promise<BeginUploadResponse>;
  /**
   * Sends one gzipped file with the exact headers the store signed. A 412
   * (object already exists at this immutable key) resolves; the server
   * verifies the bytes at completion.
   */
  putObject(upload: PresignedUpload, filePath: string): Promise<void>;
  completeUpload(
    repositoryId: number,
    sessionId: string,
    uploadId: string,
    body: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse>;
  listSessions(
    repositoryId: number,
    query: ListSessionsQuery,
  ): Promise<ListSessionsResponse>;
  /**
   * Downloads one object, checks compressed size and sha256 against `object`
   * BEFORE the caller may use it, gunzips to `destinationPath` with bounded
   * expansion. Any failure leaves no file at destinationPath.
   */
  getObject(
    object: StoredObject & { url: string },
    destinationPath: string,
  ): Promise<void>;
}

export interface GzippedFile {
  path: string;
  size: number;
  sha256: string;
  cleanup: () => Promise<void>;
}

/**
 * One private directory per process holds every staged upload. Its mode is
 * 0700, so other local accounts cannot list or read staged transcripts. The
 * process removes it on exit; a crash leaves it to the OS temp cleaner.
 */
let stagingDirectory: Promise<string> | null = null;

function stagingDir(): Promise<string> {
  stagingDirectory ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "review-trace-"));
    await chmod(dir, 0o700);
    process.once("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; the file modes already keep the contents private.
      }
    });

    return dir;
  })();
  stagingDirectory.catch(() => {
    stagingDirectory = null;
  });

  return stagingDirectory;
}

/**
 * Compresses one file into the private staging directory. The size and the
 * digest describe the gzipped bytes, which is what the store signs and checks.
 */
export async function gzipToTemp(sourcePath: string): Promise<GzippedFile> {
  const targetPath = path.join(
    await stagingDir(),
    `${randomBytes(8).toString("hex")}.jsonl.gz`,
  );

  const hash = createHash("sha256");

  const digestTap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      createReadStream(sourcePath),
      createGzip(),
      digestTap,
      createWriteStream(targetPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (cause) {
    await rm(targetPath, { force: true });
    throw cause;
  }

  return {
    path: targetPath,
    size: (await stat(targetPath)).size,
    sha256: hash.digest("hex"),
    cleanup: async () => {
      await rm(targetPath, { force: true });
    },
  };
}

/** The transport used at run time. */
export function createHttpTraceStoreTransport(
  client: StoreClient,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: TraceStoreTransportOptions = {},
): TraceStoreTransport {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };

  return {
    beginUpload: (repositoryId, sessionId, body) =>
      client.beginUpload(repositoryId, sessionId, body),
    completeUpload: (repositoryId, sessionId, uploadId, body) =>
      client.completeUpload(repositoryId, sessionId, uploadId, body),
    listSessions: (repositoryId, query) =>
      client.listSessions(repositoryId, query),

    async putObject(upload, filePath) {
      // The signed headers carry the content length, so the body streams
      // with a fixed length instead of chunked encoding, which S3 rejects.
      // SAFETY: the DOM lib omits `duplex` and types the body stream
      // differently, but Node's fetch accepts both. The assertion only
      // widens the init type; every field keeps its runtime value.
      const init = {
        method: "PUT",
        headers: upload.headers,
        body: Readable.toWeb(createReadStream(filePath)),
        duplex: "half",
        signal: AbortSignal.timeout(limits.timeoutMs),
      } as RequestInit;

      const response = await fetchImpl(upload.url, init);

      if (response.status === 412) {
        // The immutable key already holds bytes from an earlier attempt.
        // The store checks them at completion, so this attempt is done.
        return;
      }

      if (!response.ok) {
        throw new Error(
          await storageErrorMessage(response, `store ${upload.name}`),
        );
      }
    },

    async getObject(object, destinationPath) {
      // One deadline covers the request and the body. A mock fetch may not
      // honor the signal, so the pipeline watches it too.
      const signal = AbortSignal.timeout(limits.timeoutMs);
      const response = await fetchImpl(object.url, { method: "GET", signal });

      if (!response.ok) {
        throw new TraceObjectHttpError(
          response.status,
          await storageErrorMessage(response, "read the object"),
        );
      }

      const contentLength = response.headers.get("content-length");

      if (contentLength !== null && Number(contentLength) !== object.size) {
        throw new Error(
          `The trace store announced ${contentLength} bytes for ${object.name}; the session declared ${object.size}.`,
        );
      }

      if (!response.body) {
        throw new Error(
          `The trace store sent no body for ${object.name} (HTTP ${response.status}).`,
        );
      }

      // SAFETY: Node's fetch returns its own web stream; the DOM type only
      // names the same object.
      const compressed = Readable.fromWeb(response.body as WebReadableStream, {
        signal,
      });

      await writeVerifiedObject(compressed, object, destinationPath, limits);
    },
  };
}

/**
 * Gunzips a compressed stream into `destinationPath` and only keeps the
 * result when the compressed bytes match the declared size and digest. The
 * output lands in a private temp file next to the destination first, so a
 * failed or corrupt transfer never touches an existing file.
 */
export async function writeVerifiedObject(
  compressed: Readable,
  object: StoredObject,
  destinationPath: string,
  limits: TraceTransferLimits,
): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.${randomBytes(6).toString("hex")}.tmp`;
  const hash = createHash("sha256");
  let compressedBytes = 0;
  let expandedBytes = 0;

  const compressedTap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;

      if (compressedBytes > object.size) {
        callback(
          new Error(
            `The trace store sent more than the declared ${object.size} bytes for ${object.name}.`,
          ),
        );

        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const expansionTap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expandedBytes += chunk.byteLength;

      if (expandedBytes > limits.maxExpandedBytes) {
        callback(
          new Error(
            `${object.name} expands past the ${limits.maxExpandedBytes} byte limit.`,
          ),
        );

        return;
      }

      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      compressed,
      compressedTap,
      createGunzip(),
      expansionTap,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );

    if (compressedBytes !== object.size) {
      throw new Error(
        `The trace store sent ${compressedBytes} bytes for ${object.name}; the session declared ${object.size}.`,
      );
    }

    if (hash.digest("hex") !== object.sha256) {
      throw new Error(
        `The bytes of ${object.name} do not match the declared checksum.`,
      );
    }

    await rename(tempPath, destinationPath);
  } catch (cause) {
    await rm(tempPath, { force: true });
    throw cause;
  }
}

/**
 * A presigned URL carries credentials, so no message shows it. S3 answers with
 * an XML body whose `Code` names the fault.
 */
async function storageErrorMessage(
  response: Response,
  action: string,
): Promise<string> {
  let code: string | null = null;

  try {
    code = /<Code>([^<]+)<\/Code>/.exec(await response.text())?.[1] ?? null;
  } catch {
    code = null;
  }

  return code
    ? `The trace store did not ${action} (HTTP ${response.status}: ${code}).`
    : `The trace store did not ${action} (HTTP ${response.status}).`;
}
