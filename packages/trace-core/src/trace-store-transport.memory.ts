// The in-memory transport for tests. It keeps the same objects the server
// keeps and applies the server's publication rules, so no test opens a
// socket. Nothing in the shipped CLI imports this file.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import {
  DEFAULT_TRACE_SESSIONS_PAGE,
  type ListSessionsResponse,
  type StoredObject,
  type TraceHarness,
  type TraceObjectName,
  traceObjectKey,
} from "@dev.fast/trace-shared";

import { StoreApiError } from "./store-client";
import {
  DEFAULT_LIMITS,
  type TraceStoreTransport,
  type TraceStoreTransportOptions,
  writeVerifiedObject,
} from "./trace-store-transport";

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
