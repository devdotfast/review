import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { shareManifestSchema } from "@dev.fast/review-share-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { runReviewCli } from "../cli-runner.js";
import { ReviewApiClient } from "../review-api/client.js";
import type { ReviewServerDiscovery } from "../server-discovery.js";
import * as repository from "../sharing/repository.js";
import { runHeadlessServer } from "./headless-host.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("commits and uploads through a real headless server and CLI without Desktop, disk auth or model credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-headless-sharing-"));
  const fixture = await createShareFixture(root);
  const stateDir = path.join(root, "server");
  const pins = fixture.store.read(fixture.reviewId).pins;

  vi.spyOn(repository, "readShareRepository").mockResolvedValue(
    fixture.repository,
  );
  vi.spyOn(repository, "verifyShareRepository").mockResolvedValue(
    fixture.repository,
  );

  vi.stubEnv("DEV_REVIEW_SHARE_TOKEN", "ci-publish-token");
  vi.stubEnv("DEV_REVIEW_SHARE_ORIGIN", "https://sharing.test");
  vi.stubEnv("DEV_REVIEW_HOME", stateDir);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
  const realFetch = globalThis.fetch;
  const requests: { url: string; headers: Headers; body?: string }[] = [];
  const blobs = new Map<string, Buffer>();
  const shareId = randomUUID();
  const link = `https://sharing.test/s/${shareId}#${"x".repeat(43)}`;
  vi.stubGlobal(
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname !== "sharing.test" && url.hostname !== "objects.test")
        return realFetch(input, init);
      requests.push({
        url: url.href,
        headers: new Headers(init?.headers),
        body:
          init?.body && url.hostname === "sharing.test"
            ? String(init.body)
            : undefined,
      });

      if (url.hostname === "objects.test") {
        // SAFETY: ShareClient's object upload request body is a Buffer.
        blobs.set(url.pathname, Buffer.from(init!.body as Uint8Array));

        return new Response(null, { status: 200 });
      }

      const signed = (name: string) => ({
        url: `https://objects.test/${name}`,
        headers: {},
        expiresAt: "2099",
      });

      if (url.pathname === "/api/shares")
        return Response.json({ shareId, upload: signed("manifest") });

      if (url.pathname.endsWith("/manifest")) {
        const manifest = shareManifestSchema.parse(
          JSON.parse(blobs.get("/manifest")!.toString()),
        );

        return Response.json({
          registered: true,
          uploads: Object.fromEntries(
            manifest.objects.map(({ id }) => [id, signed(id)]),
          ),
        });
      }

      return Response.json({ shareId, url: link });
    },
  );
  const abort = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir,
    signal: abort.signal,
    onReady: ready.resolve,
  });

  try {
    const discovery = await Promise.race([
      ready.promise,
      running.then(() => {
        throw new Error("Server exited before readiness");
      }),
    ]);

    const client = new ReviewApiClient({
      serverUrl: discovery.url,
      apiPath: "/sessions-api",
      modelNames: "review",
      token: discovery.token,
    });

    const registered = await client.post<{ id: string }>("/repositories", {
      path: fixture.repo,
    });

    const d = await client.post<{ reviewId: string }>("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "CI review",
        pins: { ...pins, repositoryId: registered.id },
      },
    });

    const traceId = randomUUID();
    await client.post("/resources", {
      id: traceId,
      repositoryId: registered.id,
      kind: "trace",
      trace: {
        label: "Evidence",
        events: [{ id: "one", role: "user", text: "Explain the answer" }],
      },
    });
    await client.post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId: d.reviewId,
        edit: {
          type: "insert",
          content: {
            type: "section",
            title: "Summary",
            children: [
              {
                type: "code_peek",
                source: {
                  file: fixture.sourceFile,
                  start: { side: "head", line: 1 },
                  end: { side: "head", line: 1 },
                },
              },
              {
                type: "trace_quote",
                traceId,
                eventId: "one",
                text: "Explain the answer",
              },
            ],
          },
        },
      },
    });
    const requestId = randomUUID();

    for (let attempt = 0; attempt < 2; attempt++) {
      const stdout = new PassThrough(),
        stderr = new PassThrough();

      let output = "";
      stdout.on("data", (chunk) => {
        output += chunk;
      });

      const code = await runReviewCli({
        product: "whiteboard",
        argv: [
          "--state-dir",
          stateDir,
          "share",
          "--session",
          d.reviewId,
          "--version",
          "1",
          "--request-id",
          requestId,
          "--json",
        ],
        env: {
          ...process.env,
          DEV_REVIEW_SERVER_DIR: path.join(root, "wrong-server"),
        },
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({ shareId, url: link, version: 1 });
      expect(output).not.toContain("ci-publish-token");
    }

    expect(
      requests
        .values()
        .filter((r) => r.url.endsWith("/api/shares"))
        .map((r) => JSON.parse(r.body!).requestId)
        .toArray(),
    ).toEqual([requestId, requestId]);
    expect(blobs.size).toBeGreaterThan(1);
    expect(blobs.get("/manifest")!.toString()).toContain("CI review");

    for (const request of requests)
      expect(request.headers.get("authorization")).toBe(
        request.url.startsWith("https://sharing.test")
          ? "Bearer ci-publish-token"
          : null,
      );
    await expect(
      readFile(path.join(stateDir, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    abort.abort();
    await running;
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const json of [false, true]) {
  it(`reports share failures on stderr while preserving JSON output (json=${json})`, async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "review-share-error-"));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = "";
    let diagnostic = "";
    stdout.on("data", (chunk) => {
      output += chunk;
    });
    stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });

    try {
      const code = await runReviewCli({
        argv: [
          "--state-dir",
          stateDir,
          "share",
          "--review",
          randomUUID(),
          ...(json ? ["--json"] : []),
        ],
        env: process.env,
        stdout,
        stderr,
      });

      expect(code).toBe(1);
      expect(diagnostic).toContain("Review server is not ready");
      expect(diagnostic).toContain("review server start");
      expect(json ? JSON.parse(output) : output).toEqual(
        json
          ? { error: { code: "share_failed", message: diagnostic.trim() } }
          : "",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
