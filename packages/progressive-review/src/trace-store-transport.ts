// Transport for the hosted trace store.
//
// The CLI ships a session as gzipped objects through presigned S3 URLs and
// reads them back the same way. The HTTP transport talks to the real store.
// The memory transport keeps the same contract in a Map so tests never open a
// socket. Both transports verify every download the same way before a caller
// may read it.

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
import { createGunzip, createGzip, gzipSync } from "node:zlib";

import {
  type BeginUploadRequest,
  type BeginUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  DEFAULT_TRACE_SESSIONS_PAGE,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type PresignedUpload,
  type StoredObject,
  type TraceHarness,
  type TraceObjectName,
  traceObjectKey,
} from "@dev.fast/trace-shared";

import { StoreApiError, type StoreClient } from "./store-client";

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

const DEFAULT_LIMITS: TraceTransferLimits = {
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
        throw new Error(await storageErrorMessage(response, "read the object"));
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
async function writeVerifiedObject(
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

export interface MemoryTraceStoreSession {
  repositoryId: number;
  sessionId: string;
  harness: TraceHarness;
  updatedAt: string;
  commits: string[];
  branch: string | null;
  author: string | null;
  /** The published upload, or null while no upload has completed. */
  currentUploadId: string | null;
  /** Counts publications. Zero means nothing is published. */
  generation: number;
}

export interface MemoryTraceStoreUpload {
  uploadId: string;
  repositoryId: number;
  sessionId: string;
  harness: TraceHarness;
  baseGeneration: number;
  status: "pending" | "complete";
  /** The generation this upload published as, or null while pending. */
  generation: number | null;
  objects: StoredObject[];
  /** Object key by object name. */
  keys: Record<string, string>;
  /** The commits the completion receipt reported. */
  commits: string[];
  /** The labels the completion carried. */
  branch: string | null;
  author: string | null;
}

export interface MemoryTraceStoreTransport extends TraceStoreTransport {
  /** The store instance every object key names. */
  storeId: string;
  /** Gzipped object bytes, keyed by the immutable object key. */
  objects: Map<string, Buffer>;
  /** Sessions, keyed by `memoryTraceSessionKey`. */
  sessions: Map<string, MemoryTraceStoreSession>;
  /** Uploads, keyed by upload id. */
  uploads: Map<string, MemoryTraceStoreUpload>;
}

/** Tests address memory objects through URLs that never reach the network. */
const MEMORY_URL_PREFIX = "https://trace-store.invalid/";
const MEMORY_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const MEMORY_STORE_ID = "0123456789abcdef0123456789abcdef";

export function memoryTraceSessionKey(
  repositoryId: number,
  sessionId: string,
): string {
  return `r${repositoryId}/sessions/${sessionId}`;
}

function memoryObjectKey(url: string): string {
  return url.slice(MEMORY_URL_PREFIX.length);
}

function newUploadId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * An in-memory store for tests. It keeps the same objects the server keeps
 * and applies the server's publication rules: keys are immutable, a
 * completion checks every object, and a stale base generation is a conflict.
 */
export function createMemoryTraceStoreTransport(
  options: TraceStoreTransportOptions & {
    storeId?: string;
    /** Sessions per listing page; the server's default otherwise. */
    pageSize?: number;
  } = {},
): MemoryTraceStoreTransport {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const storeId = options.storeId ?? MEMORY_STORE_ID;
  const pageSize = options.pageSize ?? DEFAULT_TRACE_SESSIONS_PAGE;
  const objects = new Map<string, Buffer>();
  const sessions = new Map<string, MemoryTraceStoreSession>();
  const uploads = new Map<string, MemoryTraceStoreUpload>();

  return {
    storeId,
    objects,
    sessions,
    uploads,

    async beginUpload(repositoryId, sessionId, body) {
      const session = sessions.get(
        memoryTraceSessionKey(repositoryId, sessionId),
      );
      const uploadId = newUploadId();
      const keys: Record<string, string> = {};
      for (const object of body.objects) {
        keys[object.name] = traceObjectKey({
          repositoryId,
          storeId,
          sessionId,
          uploadId,
          name: object.name,
        });
      }
      const baseGeneration = session?.generation ?? 0;
      uploads.set(uploadId, {
        uploadId,
        repositoryId,
        sessionId,
        harness: body.harness,
        baseGeneration,
        status: "pending",
        generation: null,
        objects: body.objects.map((object) => ({ ...object })),
        keys,
        commits: [],
        branch: null,
        author: null,
      });
      return {
        uploadId,
        storeId,
        baseGeneration,
        uploads: body.objects.map((object) => ({
          name: object.name,
          url: `${MEMORY_URL_PREFIX}${keys[object.name]}`,
          headers: {
            "content-type": "application/gzip",
            "content-length": String(object.size),
            // S3 and R2 sign the digest in base64, as the real store does.
            "x-amz-checksum-sha256": Buffer.from(object.sha256, "hex").toString(
              "base64",
            ),
            "if-none-match": "*",
          },
          expiresAt: MEMORY_EXPIRES_AT,
        })),
      };
    },

    async putObject(upload, filePath) {
      // S3 rejects a body whose length or digest differs from the signed
      // headers. The memory store rejects it the same way.
      const body = await readFile(filePath);
      const declaredSize = Number(upload.headers["content-length"]);
      if (body.byteLength !== declaredSize) {
        throw new Error(
          `The trace store did not store ${upload.name} (size ${body.byteLength} does not match the signed ${declaredSize}).`,
        );
      }
      const digest = createHash("sha256").update(body).digest("base64");
      if (digest !== upload.headers["x-amz-checksum-sha256"]) {
        throw new Error(
          `The trace store did not store ${upload.name} (the digest does not match the signed checksum).`,
        );
      }
      const key = memoryObjectKey(upload.url);
      const existing = objects.get(key);
      if (existing) {
        // `if-none-match: *` makes S3 answer 412 for an occupied key. The
        // HTTP transport treats identical bytes as done; different bytes
        // mean a signed URL was reused against another upload.
        if (existing.equals(body)) return;
        throw new Error(
          `The trace store did not store ${upload.name} (HTTP 412: PreconditionFailed).`,
        );
      }
      objects.set(key, body);
    },

    async completeUpload(repositoryId, sessionId, uploadId, body) {
      const upload = uploads.get(uploadId);
      if (
        !upload ||
        upload.repositoryId !== repositoryId ||
        upload.sessionId !== sessionId
      ) {
        throw new StoreApiError(
          "not_found",
          404,
          "This session has no such upload.",
        );
      }
      if (upload.status === "complete" && upload.generation !== null) {
        const current = sessions.get(
          memoryTraceSessionKey(repositoryId, sessionId),
        );
        if (current && current.currentUploadId === uploadId) {
          // Completing the current upload again links any new commits.
          const merged = [...new Set([...current.commits, ...body.commits])];
          current.commits = merged;
          upload.commits = merged;
        }
        return {
          sessionId,
          uploadId,
          generation: upload.generation,
          objects: upload.objects.map((object) => ({ ...object })),
          commits: [...upload.commits],
        };
      }
      const missing = upload.objects.filter((object) => {
        const stored = objects.get(upload.keys[object.name] ?? "");
        return (
          !stored ||
          stored.byteLength !== object.size ||
          createHash("sha256").update(stored).digest("hex") !== object.sha256
        );
      });
      if (missing.length > 0) {
        throw new StoreApiError(
          "upload_incomplete",
          409,
          `The store did not receive these objects: ${missing
            .map((object) => object.name)
            .join(", ")}.`,
        );
      }
      const sessionKey = memoryTraceSessionKey(repositoryId, sessionId);
      const session = sessions.get(sessionKey);
      if ((session?.generation ?? 0) !== upload.baseGeneration) {
        throw new StoreApiError(
          "stale_upload",
          409,
          "Another upload published after this one began. Start a new upload.",
        );
      }
      const generation = upload.baseGeneration + 1;
      const commits = [
        ...new Set([...(session?.commits ?? []), ...body.commits]),
      ];
      sessions.set(sessionKey, {
        repositoryId,
        sessionId,
        harness: upload.harness,
        updatedAt: new Date().toISOString(),
        commits,
        branch: body.branch ?? null,
        author: body.author ?? null,
        currentUploadId: uploadId,
        generation,
      });
      upload.status = "complete";
      upload.generation = generation;
      upload.commits = commits;
      upload.branch = body.branch ?? null;
      upload.author = body.author ?? null;
      return {
        sessionId,
        uploadId,
        generation,
        objects: upload.objects.map((object) => ({ ...object })),
        commits: [...commits],
      };
    },

    async listSessions(repositoryId, query) {
      const matches = [...sessions.values()]
        .filter(
          (session) =>
            session.repositoryId === repositoryId &&
            session.currentUploadId !== null &&
            (query.session === undefined ||
              session.sessionId === query.session) &&
            (query.commit === undefined ||
              session.commits.includes(query.commit)) &&
            (query.cursor === undefined || session.sessionId > query.cursor),
        )
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const limit = query.limit ?? pageSize;
      const page = matches.slice(0, limit);
      const response: ListSessionsResponse = {
        sessions: page.map((session) => {
          const upload = uploads.get(session.currentUploadId ?? "");
          if (!upload) {
            throw new Error("A published session lost its upload.");
          }
          return {
            sessionId: session.sessionId,
            harness: session.harness,
            uploadId: upload.uploadId,
            generation: session.generation,
            updatedAt: session.updatedAt,
            commits: [...session.commits],
            branch: session.branch,
            author: session.author,
            objects: upload.objects.map((object) => ({
              ...object,
              url: `${MEMORY_URL_PREFIX}${upload.keys[object.name]}`,
              expiresAt: MEMORY_EXPIRES_AT,
            })),
          };
        }),
      };
      const last = page[page.length - 1];
      if (matches.length > limit && last) response.nextCursor = last.sessionId;
      return response;
    },

    async getObject(object, destinationPath) {
      const compressed = objects.get(memoryObjectKey(object.url));
      if (!compressed) {
        throw new Error("The trace store has no object at that address.");
      }
      await writeVerifiedObject(
        Readable.from([compressed]),
        object,
        destinationPath,
        limits,
      );
    },
  };
}

export interface SeedMemoryTraceSessionInput {
  repositoryId: number;
  sessionId: string;
  harness?: TraceHarness;
  commits?: string[];
  /** Raw JSONL content by object name, for example `main.jsonl.gz`. */
  traces: Partial<Record<TraceObjectName, string>>;
}

/**
 * Publishes one session into a memory transport the way a complete upload
 * would: gzipped objects under immutable keys, a complete upload, and a
 * session that points at it.
 */
export function seedMemoryTraceSession(
  transport: MemoryTraceStoreTransport,
  input: SeedMemoryTraceSessionInput,
): MemoryTraceStoreUpload {
  const { repositoryId, sessionId } = input;
  const uploadId = newUploadId();
  const sessionKey = memoryTraceSessionKey(repositoryId, sessionId);
  const existing = transport.sessions.get(sessionKey);
  const generation = (existing?.generation ?? 0) + 1;
  const objects: StoredObject[] = [];
  const keys: Record<string, string> = {};
  for (const [name, content] of Object.entries(input.traces)) {
    if (content === undefined) continue;
    // SAFETY: the record's keys are object names; Object.entries widens them.
    const objectName = name as TraceObjectName;
    const compressed = gzipSync(Buffer.from(content, "utf8"));
    const key = traceObjectKey({
      repositoryId,
      storeId: transport.storeId,
      sessionId,
      uploadId,
      name: objectName,
    });
    transport.objects.set(key, compressed);
    keys[objectName] = key;
    objects.push({
      name: objectName,
      size: compressed.byteLength,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    });
  }
  const commits = [
    ...new Set([...(existing?.commits ?? []), ...(input.commits ?? [])]),
  ];
  const upload: MemoryTraceStoreUpload = {
    uploadId,
    repositoryId,
    sessionId,
    harness: input.harness ?? "claude",
    baseGeneration: generation - 1,
    status: "complete",
    generation,
    objects,
    keys,
    commits,
    branch: null,
    author: null,
  };
  transport.uploads.set(uploadId, upload);
  transport.sessions.set(sessionKey, {
    repositoryId,
    sessionId,
    harness: upload.harness,
    updatedAt: "2026-09-02T12:00:10.000Z",
    commits,
    branch: null,
    author: null,
    currentUploadId: uploadId,
    generation,
  });
  return upload;
}
