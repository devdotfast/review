import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { type StoredObject, traceObjectKey } from "@dev.fast/trace-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { pullReviewTraceCorpus, syncReviewTrace } from "./review-agent-traces";
import { StoreApiError, StoreClient } from "./store-client";
import {
  type TraceRepositoryTarget,
  traceTargetKey,
} from "./trace-repository-target";
import {
  recordTraceSessionProvenance,
  traceCaptureIdentity,
} from "./trace-session-provenance";
import { HostedTraceStorage } from "./trace-storage/hosted";
import {
  type MemoryTraceStoreTransport,
  type TraceStoreTransportOptions,
  createHttpTraceStoreTransport,
  createMemoryTraceStoreTransport,
  gzipToTemp,
  memoryTraceSessionKey,
  seedMemoryTraceSession,
} from "./trace-store-transport";
import { allowTraceRepository, denyTraceRepository } from "./trace-user-config";

const REPOSITORY_ID = 123;
const SESSION_ID = "session-0001";

function testTarget(storeId: string): TraceRepositoryTarget {
  return {
    origin: "https://app.dev.fast",
    repositoryId: REPOSITORY_ID,
    storeId,
    name: "acme/app",
  };
}

/** Gzips `content` and describes it the way a store manifest does. */
function compressedObject(
  content: string,
  name: StoredObject["name"] = "main.jsonl.gz",
) {
  const compressed = zlib.gzipSync(Buffer.from(content, "utf8"));
  const object = {
    name,
    size: compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    url: "https://r2.test/object?sig",
  } satisfies StoredObject & { url: string };
  return { compressed, object };
}

function httpTransport(
  fetchImpl: typeof fetch,
  options?: TraceStoreTransportOptions,
) {
  return createHttpTraceStoreTransport({} as StoreClient, fetchImpl, options);
}

/** A fetch that answers every GET with `body` and the given headers. */
function respondWith(body: Buffer | ReadableStream, headers = {}) {
  const bodyInit = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
  return vi.fn<typeof fetch>(
    async () => new Response(bodyInit, { status: 200, headers }),
  );
}

/** Stages one gzipped upload in a memory transport without completing it. */
async function stageUpload(
  transport: MemoryTraceStoreTransport,
  sourcePath: string,
) {
  const gzipped = await gzipToTemp(sourcePath);
  const begun = await transport.beginUpload(REPOSITORY_ID, SESSION_ID, {
    harness: "claude",
    objects: [
      { name: "main.jsonl.gz", size: gzipped.size, sha256: gzipped.sha256 },
    ],
  });
  return { gzipped, begun, upload: begun.uploads[0] };
}

describe("trace-store-transport", () => {
  let tempDir: string;
  let devHome: string;
  let localTraceRoot: string;
  let corpusRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `trace-transport-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    devHome = path.join(tempDir, "dev-home");
    localTraceRoot = path.join(tempDir, "local-traces");
    corpusRoot = path.join(devHome, "trace-search");
    repoDir = path.join(tempDir, "repo");
    for (const dir of [devHome, localTraceRoot, corpusRoot, repoDir]) {
      mkdirSync(dir, { recursive: true });
    }
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("TRACE_LOCAL_TRACE_ROOT", localTraceRoot);

    execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repoDir },
    );
    await allowTraceRepository({
      repositoryId: REPOSITORY_ID,
      name: "acme/app",
      origin: "https://app.dev.fast",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("gzips a file and reports size and sha256", async () => {
    const source = path.join(tempDir, "hello.jsonl");
    await writeFile(source, "hello\n", "utf8");

    const gzipped = await gzipToTemp(source);

    expect(gzipped.size).toBeGreaterThan(0);
    expect(gzipped.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The digest describes the gzipped bytes the store signs.
    expect(
      createHash("sha256").update(readFileSync(gzipped.path)).digest("hex"),
    ).toBe(gzipped.sha256);
    expect(zlib.gunzipSync(await readFile(gzipped.path)).toString("utf8")).toBe(
      "hello\n",
    );

    await gzipped.cleanup();
    expect(existsSync(gzipped.path)).toBe(false);
  });

  it("stages gzipped files privately", async () => {
    const previousUmask = process.umask(0o022);
    try {
      const source = path.join(tempDir, "private.jsonl");
      await writeFile(source, "secret\n", "utf8");

      const gzipped = await gzipToTemp(source);

      expect(statSync(gzipped.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(gzipped.path)).mode & 0o777).toBe(0o700);
      await gzipped.cleanup();
    } finally {
      process.umask(previousUmask);
    }
  });

  it("sends a fixed content length on the wire, never chunked", async () => {
    const { createServer } = await import("node:http");
    const source = path.join(tempDir, "wire.jsonl");
    await writeFile(source, "hello wire\n", "utf8");
    const gzipped = await gzipToTemp(source);
    let receivedHeaders: IncomingHttpHeaders = {};
    let receivedBytes = 0;
    const server = createServer((request, response) => {
      receivedHeaders = request.headers;
      request.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      request.on("end", () => {
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    // The listener's address is external input to this test; parse it.
    const { port } = z.object({ port: z.number() }).parse(server.address());
    try {
      await httpTransport(globalThis.fetch).putObject(
        {
          name: "main.jsonl.gz",
          url: `http://127.0.0.1:${port}/k`,
          headers: {
            "content-type": "application/gzip",
            "content-length": String(gzipped.size),
            "x-amz-checksum-sha256": Buffer.from(
              gzipped.sha256,
              "hex",
            ).toString("base64"),
            "if-none-match": "*",
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        gzipped.path,
      );
      expect(receivedHeaders["content-length"]).toBe(String(gzipped.size));
      expect(receivedHeaders["transfer-encoding"]).toBeUndefined();
      expect(receivedBytes).toBe(gzipped.size);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await gzipped.cleanup();
    }
  });

  it("puts the object with the presigned headers", async () => {
    const source = path.join(tempDir, "put.jsonl");
    await writeFile(source, "hello\n", "utf8");
    const gzipped = await gzipToTemp(source);
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    await httpTransport(fetchImpl).putObject(
      {
        name: "main.jsonl.gz",
        url: "https://r2.test/k?sig",
        headers: {
          "content-type": "application/gzip",
          "content-length": String(gzipped.size),
          "x-amz-checksum-sha256": "x",
          "if-none-match": "*",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      gzipped.path,
    );

    expect(fetchImpl.mock.calls[0][0]).toBe("https://r2.test/k?sig");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      duplex: "half",
      headers: expect.objectContaining({
        "x-amz-checksum-sha256": "x",
        "if-none-match": "*",
      }),
    });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await gzipped.cleanup();
  });

  it("treats a 412 as a stored object and hides the URL from other faults", async () => {
    const source = path.join(tempDir, "put.jsonl");
    await writeFile(source, "hello\n", "utf8");
    const gzipped = await gzipToTemp(source);
    const upload = {
      name: "main.jsonl.gz" as const,
      url: "https://r2.test/k?sig=secret",
      headers: { "if-none-match": "*" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    await expect(
      httpTransport(async () => new Response(null, { status: 412 })).putObject(
        upload,
        gzipped.path,
      ),
    ).resolves.toBeUndefined();

    await expect(
      httpTransport(
        async () =>
          new Response("<Error><Code>AccessDenied</Code></Error>", {
            status: 403,
          }),
      ).putObject(upload, gzipped.path),
    ).rejects.toThrow(
      /^The trace store did not store main.jsonl.gz \(HTTP 403: AccessDenied\)\.$/,
    );
    await gzipped.cleanup();
  });

  describe("getObject", () => {
    it("verifies size and checksum then writes the expanded bytes privately", async () => {
      const { compressed, object } = compressedObject("hello\n");
      const destination = path.join(tempDir, "out", "main.jsonl");
      const fetchImpl = respondWith(compressed, {
        "content-length": String(compressed.byteLength),
      });

      await httpTransport(fetchImpl).getObject(object, destination);

      expect(readFileSync(destination, "utf8")).toBe("hello\n");
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(readdirSync(path.dirname(destination))).toEqual(["main.jsonl"]);
    });

    it("rejects a checksum mismatch and keeps the previous file", async () => {
      const { compressed, object } = compressedObject("replaced\n");
      const destination = path.join(tempDir, "main.jsonl");
      writeFileSync(destination, "previous\n");

      await expect(
        httpTransport(respondWith(compressed)).getObject(
          { ...object, sha256: "0".repeat(64) },
          destination,
        ),
      ).rejects.toThrow(/checksum/);

      expect(readFileSync(destination, "utf8")).toBe("previous\n");
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith("main")),
      ).toEqual(["main.jsonl"]);
    });

    it("rejects a size mismatch from the headers or from the body", async () => {
      const { compressed, object } = compressedObject("hello\n");
      const destination = path.join(tempDir, "main.jsonl");

      await expect(
        httpTransport(
          respondWith(compressed, {
            "content-length": String(compressed.byteLength + 1),
          }),
        ).getObject(object, destination),
      ).rejects.toThrow(/announced/);
      await expect(
        httpTransport(respondWith(compressed)).getObject(
          { ...object, size: object.size + 1 },
          destination,
        ),
      ).rejects.toThrow(/declared/);
      await expect(
        httpTransport(respondWith(compressed)).getObject(
          { ...object, size: object.size - 1 },
          destination,
        ),
      ).rejects.toThrow(/more than the declared/);

      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(tempDir).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    });

    it("stops a download that expands past the limit", async () => {
      const { compressed, object } = compressedObject("a".repeat(64 * 1024));
      const destination = path.join(tempDir, "main.jsonl");
      expect(compressed.byteLength).toBeLessThan(1024);

      await expect(
        httpTransport(respondWith(compressed), {
          limits: { maxExpandedBytes: 4096 },
        }).getObject(object, destination),
      ).rejects.toThrow(/expands past the 4096 byte limit/);

      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(tempDir).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    });

    it("times out a stalled response", async () => {
      const { object } = compressedObject("hello\n");
      const destination = path.join(tempDir, "main.jsonl");
      const stalled = new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => {}),
      });

      await expect(
        httpTransport(respondWith(stalled), {
          limits: { timeoutMs: 50 },
        }).getObject(object, destination),
      ).rejects.toThrow(/abort|timeout/i);

      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(tempDir).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    });
  });

  describe("memory transport", () => {
    let source: string;

    beforeEach(async () => {
      source = path.join(tempDir, "trace.jsonl");
      await writeFile(source, `${JSON.stringify({ type: "session" })}\n`);
    });

    it("keeps objects immutable and publishes on completion", async () => {
      const transport = createMemoryTraceStoreTransport();
      const { gzipped, begun, upload } = await stageUpload(transport, source);
      expect(begun.baseGeneration).toBe(0);
      expect(upload.headers["if-none-match"]).toBe("*");
      expect(upload.url).toContain(
        traceObjectKey({
          repositoryId: REPOSITORY_ID,
          storeId: transport.storeId,
          sessionId: SESSION_ID,
          uploadId: begun.uploadId,
          name: "main.jsonl.gz",
        }),
      );

      await expect(
        transport.completeUpload(REPOSITORY_ID, SESSION_ID, begun.uploadId, {
          commits: [],
        }),
      ).rejects.toMatchObject({ code: "upload_incomplete", status: 409 });

      await transport.putObject(upload, gzipped.path);
      // A retried PUT of identical bytes resolves like an S3 412 does.
      await expect(
        transport.putObject(upload, gzipped.path),
      ).resolves.toBeUndefined();

      const receipt = await transport.completeUpload(
        REPOSITORY_ID,
        SESSION_ID,
        begun.uploadId,
        { commits: ["a".repeat(40)] },
      );
      expect(receipt).toMatchObject({
        uploadId: begun.uploadId,
        generation: 1,
        commits: ["a".repeat(40)],
      });
      // Repeating the completion returns the same receipt.
      await expect(
        transport.completeUpload(REPOSITORY_ID, SESSION_ID, begun.uploadId, {
          commits: [],
        }),
      ).resolves.toEqual(receipt);
      expect(
        transport.sessions.get(
          memoryTraceSessionKey(REPOSITORY_ID, SESSION_ID),
        ),
      ).toMatchObject({ currentUploadId: begun.uploadId, generation: 1 });

      const listed = await transport.listSessions(REPOSITORY_ID, {
        session: SESSION_ID,
      });
      expect(listed.sessions[0]).toMatchObject({
        uploadId: begun.uploadId,
        generation: 1,
        objects: [expect.objectContaining({ name: "main.jsonl.gz" })],
      });
      await expect(
        transport.completeUpload(REPOSITORY_ID, SESSION_ID, "f".repeat(32), {
          commits: [],
        }),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await gzipped.cleanup();
    });

    it("rejects a completion whose base generation is stale", async () => {
      const transport = createMemoryTraceStoreTransport();
      const first = await stageUpload(transport, source);
      const second = await stageUpload(transport, source);
      await transport.putObject(first.upload, first.gzipped.path);
      await transport.putObject(second.upload, second.gzipped.path);

      await transport.completeUpload(
        REPOSITORY_ID,
        SESSION_ID,
        second.begun.uploadId,
        { commits: [] },
      );

      await expect(
        transport.completeUpload(
          REPOSITORY_ID,
          SESSION_ID,
          first.begun.uploadId,
          { commits: [] },
        ),
      ).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(StoreApiError);
        expect(error).toMatchObject({ code: "stale_upload", status: 409 });
        return true;
      });
      expect(
        transport.sessions.get(
          memoryTraceSessionKey(REPOSITORY_ID, SESSION_ID),
        ),
      ).toMatchObject({
        currentUploadId: second.begun.uploadId,
        generation: 1,
      });
      await first.gzipped.cleanup();
      await second.gzipped.cleanup();
    });

    it("rejects different bytes at an occupied key", async () => {
      const transport = createMemoryTraceStoreTransport();
      const { gzipped, upload } = await stageUpload(transport, source);
      await transport.putObject(upload, gzipped.path);
      const other = path.join(tempDir, "other.jsonl");
      await writeFile(other, "other\n");
      const otherGzipped = await gzipToTemp(other);

      await expect(
        transport.putObject(
          {
            ...upload,
            headers: {
              ...upload.headers,
              "content-length": String(otherGzipped.size),
              "x-amz-checksum-sha256": Buffer.from(
                otherGzipped.sha256,
                "hex",
              ).toString("base64"),
            },
          },
          otherGzipped.path,
        ),
      ).rejects.toThrow(/412/);
      await gzipped.cleanup();
      await otherGzipped.cleanup();
    });

    it("verifies downloads like the HTTP transport", async () => {
      const transport = createMemoryTraceStoreTransport({
        limits: { maxExpandedBytes: 4096 },
      });
      const seeded = seedMemoryTraceSession(transport, {
        repositoryId: REPOSITORY_ID,
        sessionId: SESSION_ID,
        traces: { "main.jsonl.gz": "hello\n" },
      });
      const listed = await transport.listSessions(REPOSITORY_ID, {
        session: SESSION_ID,
      });
      const object = listed.sessions[0].objects[0];
      const destination = path.join(tempDir, "main.jsonl");

      await transport.getObject(object, destination);
      expect(readFileSync(destination, "utf8")).toBe("hello\n");

      await expect(
        transport.getObject({ ...object, sha256: "0".repeat(64) }, destination),
      ).rejects.toThrow(/checksum/);
      expect(readFileSync(destination, "utf8")).toBe("hello\n");

      const bomb = zlib.gzipSync(Buffer.from("a".repeat(64 * 1024)));
      transport.objects.set(seeded.keys["main.jsonl.gz"], bomb);
      await expect(
        transport.getObject(
          {
            ...object,
            size: bomb.byteLength,
            sha256: createHash("sha256").update(bomb).digest("hex"),
          },
          destination,
        ),
      ).rejects.toThrow(/expands past/);
      expect(readFileSync(destination, "utf8")).toBe("hello\n");
    });
  });

  it("sync uploads main and subagent files then completes with trailer commits", async () => {
    const sessionId = "session-0001";
    writeFileSync(
      path.join(localTraceRoot, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
    const subagentsDir = path.join(localTraceRoot, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-sub1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sub1" })}\n`,
    );
    writeFileSync(path.join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
    execFileSync(
      "git",
      ["commit", "-m", `Add a\n\nAgent-Session: ${sessionId}`],
      { cwd: repoDir },
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const transport = createMemoryTraceStoreTransport();
    const target = testTarget(transport.storeId);
    await recordTraceSessionProvenance({
      sessionId,
      ...traceCaptureIdentity({ target }),
    });

    const result = await syncReviewTrace({
      sessionId,
      cwd: repoDir,
      storage: HostedTraceStorage.fromParts({ target, transport }),
    });

    const session = transport.sessions.get(
      memoryTraceSessionKey(REPOSITORY_ID, sessionId),
    );
    const upload = transport.uploads.get(session?.currentUploadId ?? "");
    expect(upload?.status).toBe("complete");
    expect(transport.objects.has(upload?.keys["main.jsonl.gz"] ?? "")).toBe(
      true,
    );
    expect(
      transport.objects.has(
        upload?.keys["subagents/agent-sub1.jsonl.gz"] ?? "",
      ),
    ).toBe(true);
    expect(result.hosted?.repositoryId).toBe(REPOSITORY_ID);
    expect(result.hosted?.complete).toBe(true);
    expect(result.hosted?.objects).toEqual([
      "main.jsonl.gz",
      "subagents/agent-sub1.jsonl.gz",
    ]);
    expect(result.hosted?.commits).toEqual([sha]);
    expect(result.uploads.map((upload) => upload.blob)).toEqual([
      "trace.jsonl",
      "subagents/agent-sub1.jsonl",
    ]);
    expect(session?.harness).toBe("claude");
  });

  it("pull downloads and normalizes into the corpus", async () => {
    const sessionId = "session-0002";
    const transport = createMemoryTraceStoreTransport();
    const trace = [
      JSON.stringify({
        type: "session",
        id: sessionId,
        cwd: "/repo",
        timestamp: "2026-09-02T12:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-02T12:00:05Z",
        message: { role: "user", content: "Build the feature" },
      }),
    ].join("\n");
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: { "main.jsonl.gz": `${trace}\n` },
    });

    const target = testTarget(transport.storeId);
    const result = await pullReviewTraceCorpus({
      repo: { owner: "acme", repo: "app" },
      sessions: [{ id: sessionId }],
      cwd: repoDir,
      storage: HostedTraceStorage.fromParts({ target, transport }),
    });

    const corpusPath = path.join(
      corpusRoot,
      traceTargetKey(target),
      sessionId,
      "main.jsonl",
    );
    expect(existsSync(corpusPath)).toBe(true);
    expect(result.paths).toEqual([corpusPath]);
    expect(result.sessions).toEqual([
      { session: sessionId, traces: 1, events: 1, files: 1 },
    ]);
  });

  it("pull reads an onboarded store without an allow entry", async () => {
    await denyTraceRepository({ name: "acme/app" });
    const sessionId = "session-0003";
    const transport = createMemoryTraceStoreTransport();
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId,
      traces: {
        "main.jsonl.gz": `${JSON.stringify({
          type: "session",
          id: sessionId,
          cwd: "/repo",
          timestamp: "2026-09-02T12:00:00Z",
        })}\n`,
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            repositoryId: REPOSITORY_ID,
            storeId: transport.storeId,
            displayName: "acme/app",
            status: "active",
            createdAt: "2026-09-02T12:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const storage = await HostedTraceStorage.resolve({
      cwd: repoDir,
      origin: "https://store.invalid",
      write: false,
      transport,
      client: new StoreClient({
        origin: "https://store.invalid",
        token: "token",
        fetch: fetchImpl,
      }),
    });
    const result = await pullReviewTraceCorpus({
      repo: { owner: "acme", repo: "app" },
      sessions: [{ id: sessionId }],
      cwd: repoDir,
      storage,
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://store.invalid/api/trace/v1/stores?owner=acme&name=app",
    );
    expect(result.sessions).toEqual([
      { session: sessionId, traces: 1, events: 0, files: 1 },
    ]);
  });
});
