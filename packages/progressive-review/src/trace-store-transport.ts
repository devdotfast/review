// Transport for the hosted trace store.
//
// The CLI ships a session as gzipped objects through presigned S3 URLs and
// reads them back the same way. The HTTP transport talks to the real store.
// The memory transport keeps the same contract in a Map so tests never open a
// socket.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

import {
  type BeginUploadRequest,
  type BeginUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type TraceHarness,
  type TraceObjectName,
  traceObjectKey,
} from "@dev-fast/trace-shared";

import type { StoreClient } from "./store-client";

/** One presigned upload from `beginUpload`. */
export type TraceStoreUpload = BeginUploadResponse["uploads"][number];

/** One session as the store lists it, with presigned download URLs. */
export type TraceStoreSession = ListSessionsResponse["sessions"][number];

export interface TraceStoreTransport {
  beginUpload(
    repositoryId: number,
    sessionId: string,
    body: BeginUploadRequest,
  ): Promise<BeginUploadResponse>;
  /** Sends one gzipped file with the exact headers the store signed. */
  putObject(upload: TraceStoreUpload, filePath: string): Promise<void>;
  completeUpload(
    repositoryId: number,
    sessionId: string,
    body: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse>;
  listSessions(
    repositoryId: number,
    query: ListSessionsQuery,
  ): Promise<ListSessionsResponse>;
  /** Downloads one object and writes the unzipped bytes to a file. */
  getObject(url: string, destinationPath: string): Promise<void>;
}

export interface GzippedFile {
  path: string;
  size: number;
  sha256: string;
  cleanup: () => Promise<void>;
}

/**
 * Compresses one file into the temporary directory. The size and the digest
 * describe the gzipped bytes, which is what the store signs and checks.
 */
export async function gzipToTemp(sourcePath: string): Promise<GzippedFile> {
  const targetPath = path.join(
    os.tmpdir(),
    `review-trace-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.jsonl.gz`,
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
      createWriteStream(targetPath),
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
): TraceStoreTransport {
  return {
    beginUpload: (repositoryId, sessionId, body) =>
      client.beginUpload(repositoryId, sessionId, body),
    completeUpload: (repositoryId, sessionId, body) =>
      client.completeUpload(repositoryId, sessionId, body),
    listSessions: (repositoryId, query) =>
      client.listSessions(repositoryId, query),

    async putObject(upload, filePath) {
      const body = await readFile(filePath);
      const response = await fetchImpl(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body,
      });
      if (!response.ok) {
        throw new Error(
          await storageErrorMessage(response, `store ${upload.name}`),
        );
      }
    },

    async getObject(url, destinationPath) {
      const response = await fetchImpl(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(await storageErrorMessage(response, "read the object"));
      }
      const compressed = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, gunzipSync(compressed));
    },
  };
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
  objects: Array<{ name: TraceObjectName; size: number; sha256: string }>;
  complete: boolean;
}

export interface MemoryTraceStoreTransport extends TraceStoreTransport {
  /** Gzipped object bytes, keyed by `r<id>/sessions/<session>/<name>`. */
  objects: Map<string, Buffer>;
  /** Sessions, keyed by `r<id>/sessions/<session>`. */
  sessions: Map<string, MemoryTraceStoreSession>;
}

/** Tests address memory objects through URLs that never reach the network. */
const MEMORY_URL_PREFIX = "https://trace-store.invalid/";
const MEMORY_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export function memoryTraceSessionKey(
  repositoryId: number,
  sessionId: string,
): string {
  return `r${repositoryId}/sessions/${sessionId}`;
}

/** An in-memory store for tests. It keeps the same objects the server keeps. */
export function createMemoryTraceStoreTransport(): MemoryTraceStoreTransport {
  const objects = new Map<string, Buffer>();
  const sessions = new Map<string, MemoryTraceStoreSession>();

  return {
    objects,
    sessions,

    async beginUpload(repositoryId, sessionId, body) {
      const key = memoryTraceSessionKey(repositoryId, sessionId);
      const existing = sessions.get(key);
      sessions.set(key, {
        repositoryId,
        sessionId,
        harness: body.harness,
        updatedAt: new Date().toISOString(),
        commits: existing?.commits ?? [],
        objects: body.objects.map((object) => ({ ...object })),
        complete: false,
      });
      for (const object of body.objects) {
        objects.delete(traceObjectKey(repositoryId, sessionId, object.name));
      }
      return {
        uploads: body.objects.map((object) => ({
          name: object.name,
          url: `${MEMORY_URL_PREFIX}${traceObjectKey(
            repositoryId,
            sessionId,
            object.name,
          )}`,
          headers: {
            "content-type": "application/gzip",
            "content-length": String(object.size),
            // S3 and R2 sign the digest in base64, as the real store does.
            "x-amz-checksum-sha256": Buffer.from(object.sha256, "hex").toString(
              "base64",
            ),
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
      objects.set(upload.url.slice(MEMORY_URL_PREFIX.length), body);
    },

    async completeUpload(repositoryId, sessionId, body) {
      const key = memoryTraceSessionKey(repositoryId, sessionId);
      const session = sessions.get(key);
      if (!session) throw new Error("This session has no upload.");
      const missing = session.objects.filter(
        (object) =>
          !objects.has(traceObjectKey(repositoryId, sessionId, object.name)),
      );
      if (missing.length > 0) {
        throw new Error(
          `The store did not receive these objects: ${missing
            .map((object) => object.name)
            .join(", ")}.`,
        );
      }
      const commits = [...new Set([...session.commits, ...body.commits])];
      sessions.set(key, {
        ...session,
        commits,
        complete: true,
        updatedAt: new Date().toISOString(),
      });
      return {
        sessionId,
        objects: session.objects.map((object) => ({ ...object })),
        commits,
      };
    },

    async listSessions(repositoryId, query) {
      const matches = [...sessions.values()].filter(
        (session) =>
          session.repositoryId === repositoryId &&
          session.complete &&
          (query.session === undefined ||
            session.sessionId === query.session) &&
          (query.commit === undefined ||
            session.commits.includes(query.commit)),
      );
      return {
        sessions: matches.map((session) => ({
          sessionId: session.sessionId,
          harness: session.harness,
          updatedAt: session.updatedAt,
          commits: [...session.commits],
          objects: session.objects.map((object) => ({
            ...object,
            url: `${MEMORY_URL_PREFIX}${traceObjectKey(
              session.repositoryId,
              session.sessionId,
              object.name,
            )}`,
            expiresAt: MEMORY_EXPIRES_AT,
          })),
        })),
      };
    },

    async getObject(url, destinationPath) {
      const compressed = objects.get(url.slice(MEMORY_URL_PREFIX.length));
      if (!compressed) {
        throw new Error("The trace store has no object at that address.");
      }
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, gunzipSync(compressed));
    },
  };
}
