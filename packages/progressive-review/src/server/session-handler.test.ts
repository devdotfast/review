import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CreateReviewCommentInput,
  JsonObject,
  ReviewThreadsCommit,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PostHogCaptureInput } from "../posthog-capture-client";
import {
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryCaptureClient,
} from "../progressive-review-telemetry";
import {
  REVIEW_DOCUMENT_BUNDLE_DIR,
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "../review-document-data";
import { readReviewComments } from "../review-state-store";
import {
  REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import {
  type ReviewSessionHandlerInput,
  createReviewSessionHandler,
} from "./session-handler";

const unusedAgentServices = {
  agentServer: () => {
    throw new Error("This test does not launch a native agent.");
  },
  openNativeAgentTerminal: async () => {
    throw new Error("This test does not open a native agent terminal.");
  },
} satisfies Pick<
  ReviewSessionHandlerInput,
  "agentServer" | "openNativeAgentTerminal"
>;

const reviewDocument: ReviewDocumentData = {
  format: REVIEW_DOCUMENT_FORMAT,
  title: "Review",
  routePath: "/",
  sourcePath: "review.mdx",
  body: [],
  anchors: {},
  anchorContents: {},
  softwareModels: [],
};

const needsRepublishError =
  "This review was published by an earlier version of Review and its document must be regenerated.";

let rootPath: string | undefined;

afterEach(async () => {
  if (rootPath) {
    await rm(rootPath, { recursive: true, force: true });
  }
  rootPath = undefined;
});

describe("createReviewSessionHandler", () => {
  it("offers current repair metadata when a sealed artifact is missing", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-missing-repair-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const reviewUuid = "11111111-1111-4111-8111-111111111111";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token: "secret",
      reviewUuid,
      documentUnavailable: "Document revision is missing.",
      softwareMapUnavailable: "Map revision is missing.",
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: "http://127.0.0.1:5570",
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      for (const artifact of ["document", "software-map"]) {
        const response = await handler.handle(
          new Request(
            `http://127.0.0.1:5570/__progressive-review/${artifact}`,
            { headers: { "x-review-token": "secret" } },
          ),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "needs_republish",
          reviewUuid,
          recovery: true,
        });
      }
    } finally {
      await handler.close();
    }
  });
  it("keeps legacy recovery and historical artifact states independent and read-only", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-recovery-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    await writeFile(reviewPath, "# Review");
    await writeReviewSoftwareMapBundle(
      rootPath,
      bundleReviewSoftwareMap({
        head: defineSoftwareMap({ systems: {} }),
        base: defineSoftwareMap({ systems: {} }),
        headCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
      }),
    );
    for (const historicalRevision of [undefined, "c".repeat(40)]) {
      const handler = await createReviewSessionHandler({
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        softwareMapRootPath: rootPath,
        routePath: "/",
        token: "secret",
        recovery: true,
        historicalRevision,
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: "http://127.0.0.1:5570",
          reviewPath,
          startedAt: Date.now(),
        },
      });
      const request = (route: string, method = "GET") =>
        handler.handle(
          new Request(`http://127.0.0.1:5570/__progressive-review/${route}`, {
            method,
            headers: { "x-review-token": "secret" },
          }),
        );
      try {
        const doc = await request("document");
        expect(doc.status).toBe(409);
        expect(await doc.json()).toMatchObject(
          historicalRevision
            ? {
                code: "historical_revision_unavailable",
                error:
                  "This older revision is unavailable in this version of Review",
                reviewUuid: "11111111-1111-4111-8111-111111111111",
              }
            : { code: "needs_republish", recovery: true, mapStale: false },
        );
        expect((await request("software-map")).status).toBe(200);
        expect((await request("dismiss", "POST")).status).toBe(409);
      } finally {
        await handler.close();
      }
    }
  });
  it("scopes routed UI telemetry and presents a session only once", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionId = "0f98956f-ec90-45b5-ae21-19acbcd8b6ef";
    const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
    const sessionUrl = `http://127.0.0.1:5570/sessions/${sessionId}`;
    const token = "session-secret";
    const events: PostHogCaptureInput[] = [];
    const captureClient: ProgressiveReviewTelemetryCaptureClient = {
      enabled: true,
      capture: async (event) => {
        events.push(event);
      },
    };
    const telemetry = new ProgressiveReviewTelemetry({
      captureClient,
      env: {},
      installConfigPath: path.join(rootPath, "telemetry.json"),
      idFactory: () => "install-123",
    });
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      sessionId,
      reviewUuid,
      telemetry,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    const capture = (name: string, properties?: JsonObject) =>
      handler.handle(
        new Request(
          new URL("/__progressive-review/telemetry/event", sessionUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-review-token": token,
              "x-review-app-session-id": "app-session-12345678",
            },
            body: JSON.stringify({ name, properties }),
          },
        ),
      );

    try {
      await expect(capture("review_presented")).resolves.toHaveProperty(
        "status",
        200,
      );
      await expect(capture("review_presented")).resolves.toHaveProperty(
        "status",
        200,
      );
      await expect(
        capture("client_error", {
          error_source: "render",
          error_process: "canvas",
          error_name: "TypeError",
        }),
      ).resolves.toHaveProperty("status", 200);

      expect(events.map((event) => event.event)).toEqual([
        "review_review_presented",
        "review_client_error",
      ]);
      expect(events[0].properties).toMatchObject({
        source: "review_app",
        app_session_id: "app-session-12345678",
        review_id: expect.stringMatching(/^rv_/),
        presentation_id: expect.stringMatching(/^pr_/),
      });
      expect(events[1].properties).toMatchObject({
        review_id: events[0].properties?.review_id,
        presentation_id: events[0].properties?.presentation_id,
      });
      expect(JSON.stringify(events)).not.toContain(reviewUuid);
      expect(JSON.stringify(events)).not.toContain(sessionId);
    } finally {
      await handler.close();
    }
  });

  it("rejects writes against a historical session with 409", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      historicalRevision: "a".repeat(40),
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const write = await handler.handle(
        new Request(
          new URL("/__progressive-review/comments/thread-1", sessionUrl),
          {
            method: "POST",
            headers: {
              "x-review-token": token,
              "content-type": "application/json",
            },
            body: JSON.stringify({}),
          },
        ),
      );
      expect(write.status).toBe(409);
      await expect(write.json()).resolves.toMatchObject({
        ok: false,
        code: "historical_revision",
      });
      const read = await handler.handle(
        new Request(new URL("/__progressive-review/comments", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(read.status).toBe(400);
      expect(await read.json()).toMatchObject({
        error: "The review thread database is unavailable.",
      });
    } finally {
      await handler.close();
    }
  });

  it("serves the version list from the host callback", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const versions = [
      {
        revision: "b".repeat(40),
        sealedAt: 1_755_000_000_000,
        isCurrent: true,
      },
    ];
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      listDocumentVersions: async () => versions,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/revisions", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, versions });
    } finally {
      await handler.close();
    }
  });

  it("serves the stored document as JSON from session-prefixed URLs", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const sessionPath = new URL(sessionUrl).pathname;
    const token = "session-secret";
    await writeFile(reviewPath, "# Review\n", "utf8");
    const bundle = bundleReviewDocument(reviewDocument);
    await writeReviewDocumentBundle(rootPath, bundle);
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    const dispatchSessionUrl = (url: string) => {
      const requestUrl = new URL(url);
      expect(requestUrl.pathname.startsWith(`${sessionPath}/`)).toBe(true);
      requestUrl.pathname = requestUrl.pathname.slice(sessionPath.length);
      return handler.handle(
        new Request(requestUrl, {
          headers: { "x-review-token": token },
        }),
      );
    };

    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/document", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        ok: true,
        contentHash: bundle.contentHash,
        documentUrl: `${sessionUrl}/__progressive-review/documents/${bundle.contentHash}.json`,
      });
      const documentResponse = await dispatchSessionUrl(payload.documentUrl);
      expect(documentResponse.status).toBe(200);
      expect(documentResponse.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(documentResponse.headers.get("cache-control")).toBe("no-store");
      await expect(documentResponse.text()).resolves.toBe(bundle.json);

      for (const documentName of ["missing.json", `${bundle.contentHash}.js`]) {
        const missing = await handler.handle(
          new Request(
            new URL(
              `/__progressive-review/documents/${documentName}`,
              sessionUrl,
            ),
            { headers: { "x-review-token": token } },
          ),
        );
        expect(missing.status).toBe(404);
        await expect(missing.json()).resolves.toEqual({
          ok: false,
          error: "Review document not found",
        });
      }

      const legacyRoute = await handler.handle(
        new Request(new URL("/__progressive-review/doc-module", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(legacyRoute.status).toBe(404);
    } finally {
      await handler.close();
    }
  });

  it.each([
    { documentState: "missing", mapState: "unpublished", mapStale: false },
    { documentState: "missing", mapState: "stale", mapStale: true },
    { documentState: "missing", mapState: "ready", mapStale: false },
    { documentState: "v1", mapState: "unpublished", mapStale: false },
    { documentState: "v1", mapState: "stale", mapStale: true },
    { documentState: "v1", mapState: "ready", mapStale: false },
  ] as const)(
    "signals $documentState documents for a $mapState map with mapStale=$mapStale",
    async ({ documentState, mapState, mapStale }) => {
      rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
      const reviewPath = path.join(rootPath, "review.mdx");
      const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
      const token = "session-secret";
      const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
      await writeFile(reviewPath, "# Review\n", "utf8");
      if (documentState === "v1") {
        const documentBundleDir = path.join(
          rootPath,
          REVIEW_DOCUMENT_BUNDLE_DIR,
        );
        await mkdir(documentBundleDir, { recursive: true });
        await writeFile(
          path.join(documentBundleDir, "manifest.json"),
          JSON.stringify({
            version: 1,
            routePath: "/",
            sourcePath: "review.mdx",
          }),
          "utf8",
        );
        await writeFile(
          path.join(documentBundleDir, "review-document.js"),
          "export default {};",
          "utf8",
        );
      }
      if (mapState === "ready") {
        await writeReviewSoftwareMapBundle(
          rootPath,
          bundleReviewSoftwareMap({
            head: defineSoftwareMap({ systems: { app: { label: "App" } } }),
            base: defineSoftwareMap({ systems: { api: { label: "API" } } }),
            headCommit: "a".repeat(40),
            baseCommit: "b".repeat(40),
          }),
        );
      }
      const softwareMapRootPath =
        mapState === "unpublished" ? undefined : rootPath;
      const handler = await createReviewSessionHandler({
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        softwareMapRootPath,
        routePath: "/",
        token,
        reviewUuid,
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: sessionUrl,
          reviewPath,
          startedAt: Date.now(),
        },
      });

      try {
        const response = await handler.handle(
          new Request(new URL("/__progressive-review/document", sessionUrl), {
            headers: { "x-review-token": token },
          }),
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          code: "needs_republish",
          error: needsRepublishError,
          reviewUuid,
          mapStale,
        });
      } finally {
        await handler.close();
      }
    },
  );

  it("fails clearly if needs-republish has no review UUID", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/document", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "A review UUID is required to report needs_republish.",
      });
    } finally {
      await handler.close();
    }
  });

  it("serves the published software map as JSON", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const sessionPath = new URL(sessionUrl).pathname;
    const token = "session-secret";
    const head = defineSoftwareMap({
      systems: { app: { label: "App" } },
    });
    const base = defineSoftwareMap({
      systems: { api: { label: "API" } },
    });
    const bundle = bundleReviewSoftwareMap({
      head,
      base,
      headCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
    });
    await writeReviewSoftwareMapBundle(rootPath, bundle);
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      softwareMapRootPath: rootPath,
      routePath: "/",
      token,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    const dispatchSessionUrl = (url: string) => {
      const requestUrl = new URL(url);
      expect(requestUrl.pathname.startsWith(`${sessionPath}/`)).toBe(true);
      requestUrl.pathname = requestUrl.pathname.slice(sessionPath.length);
      return handler.handle(
        new Request(requestUrl, {
          headers: { "x-review-token": token },
        }),
      );
    };

    try {
      const index = await handler.handle(
        new Request(new URL("/__progressive-review/software-map", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(index.status).toBe(200);
      const payload = (await index.json()) as {
        ok: true;
        contentHash: string;
        headMapUrl: string;
        baseMapUrl: string;
      };
      expect(payload).toMatchObject({
        ok: true,
        contentHash: bundle.contentHash,
      });
      expect(payload.headMapUrl).toMatch(
        /\/sessions\/test-session\/__progressive-review\/software-maps\/head-[0-9a-f]{20}\.json$/,
      );
      expect(payload.baseMapUrl).toMatch(
        /\/sessions\/test-session\/__progressive-review\/software-maps\/base-[0-9a-f]{20}\.json$/,
      );

      for (const [mapUrl, expectedPath] of [
        [payload.headMapUrl, "app"],
        [payload.baseMapUrl, "api"],
      ] as const) {
        const response = await dispatchSessionUrl(mapUrl);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/json; charset=utf-8",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        const mapJson = (await response.json()) as {
          format: string;
          elements: Array<{ path: string }>;
        };
        expect(mapJson.format).toBe("software-map/1");
        expect(mapJson.elements.map((element) => element.path)).toEqual([
          expectedPath,
        ]);
      }

      const missing = await handler.handle(
        new Request(
          new URL(
            "/__progressive-review/software-maps/head-missing.json",
            sessionUrl,
          ),
          { headers: { "x-review-token": token } },
        ),
      );
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({
        ok: false,
        error: "Software map not found",
      });
    } finally {
      await handler.close();
    }
  });

  it.each(["missing", "v1"] as const)(
    "reports a %s software map bundle as needing republish",
    async (mapState) => {
      rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
      const reviewPath = path.join(rootPath, "review.mdx");
      const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
      const token = "session-secret";
      const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
      if (mapState === "v1") {
        const softwareMapBundleDir = path.join(
          rootPath,
          REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
        );
        await mkdir(softwareMapBundleDir, { recursive: true });
        await writeFile(
          path.join(softwareMapBundleDir, "manifest.json"),
          JSON.stringify({
            version: 1,
            headCommit: "a".repeat(40),
            baseCommit: "b".repeat(40),
          }),
          "utf8",
        );
      }
      const handler = await createReviewSessionHandler({
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        softwareMapRootPath: rootPath,
        routePath: "/",
        token,
        reviewUuid,
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: sessionUrl,
          reviewPath,
          startedAt: Date.now(),
        },
      });

      try {
        const response = await handler.handle(
          new Request(
            new URL("/__progressive-review/software-map", sessionUrl),
            {
              headers: { "x-review-token": token },
            },
          ),
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          code: "needs_republish",
          error: "This review's software map must be regenerated.",
          reviewUuid,
        });
      } finally {
        await handler.close();
      }
    },
  );

  it("reports an unpublished software map when no map root exists", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/software-map", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "Software map is not published",
      });
    } finally {
      await handler.close();
    }
  });

  it("returns committed state and announces only applied changes", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const onReviewThreadsCommit =
      vi.fn<(commit: ReviewThreadsCommit) => void>();
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      onReviewThreadsCommit,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    const request = (
      path: string,
      method: "POST" | "DELETE",
      body?: CreateReviewCommentInput,
    ) => {
      const headers = new Headers({ "x-review-token": token });
      const init: RequestInit = { method, headers };
      if (body) {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(body);
      }
      return handler.handle(
        new Request(new URL(`/__progressive-review${path}`, sessionUrl), init),
      );
    };

    try {
      const comment = await request("/comments/thread-1", "POST", {
        threadId: "thread-1",
        messageId: "message-1",
        target: {
          kind: "text",
          surface: {
            type: "block",
            tag: "p",
            index: 0,
            blockHash: "12345678",
          },
          selection: {
            start: 2,
            length: 5,
            hash: "f55c314b",
            quote: "Hello",
          },
        },
        body: "A fresh external comment",
      });
      expect(comment.status).toBe(200);
      await expect(comment.json()).resolves.toMatchObject({
        ok: true,
        commit: {
          mutationId: "message-1",
          upsertedThreads: [{ threadId: "thread-1" }],
        },
      });
      expect(onReviewThreadsCommit).toHaveBeenCalledTimes(1);
    } finally {
      await handler.close();
    }
  });

  it("runs comment mutations through the publication lock seam", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    let enterMutation!: () => void;
    let releaseMutation!: () => void;
    const mutationEntered = new Promise<void>((resolve) => {
      enterMutation = resolve;
    });
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      runReviewThreadMutation: async (operation) => {
        enterMutation();
        await mutationReleased;
        return operation();
      },
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const pending = handler.handle(
        new Request(
          new URL("/__progressive-review/thread-commands", sessionUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-review-token": token,
            },
            body: JSON.stringify({
              command: "comment.create",
              mutationId: "message-1",
              input: {
                threadId: "thread-1",
                messageId: "message-1",
                target: {
                  kind: "text",
                  surface: {
                    type: "block",
                    tag: "p",
                    index: 0,
                    blockHash: "12345678",
                  },
                  selection: {
                    start: 2,
                    length: 5,
                    hash: "f55c314b",
                    quote: "Hello",
                  },
                },
                body: "A serialized comment",
              },
            }),
          },
        ),
      );
      await mutationEntered;
      expect(readReviewComments(reviewPath)).toEqual({});

      releaseMutation();
      await expect(pending).resolves.toHaveProperty("status", 200);
      expect(readReviewComments(reviewPath)).toHaveProperty("thread-1");
    } finally {
      releaseMutation();
      await handler.close();
    }
  });

  it("returns the current review status", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    let reviewStatus: "awaiting-review" | "accepted" = "awaiting-review";
    const handler = await createReviewSessionHandler(
      {
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        routePath: "/",
        token,
        getReviewStatus: () => reviewStatus,
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: sessionUrl,
          reviewPath,
          startedAt: Date.now(),
        },
      },
      { resolveReviewSessionBaseCommit: async () => null },
    );

    const request = () =>
      handler.handle(
        new Request(new URL("/__progressive-review/session", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );

    try {
      await expect(request()).resolves.toHaveProperty("status", 200);
      await expect((await request()).json()).resolves.toMatchObject({
        session: { reviewStatus: "awaiting-review" },
      });
      reviewStatus = "accepted";
      await expect((await request()).json()).resolves.toMatchObject({
        session: { reviewStatus: "accepted" },
      });
    } finally {
      await handler.close();
    }
  });

  it("acknowledges a submission before the submit hook exits", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    await writeFile(reviewPath, "# Test review\n");
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      submitHook: "sleep 1",
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const response = await Promise.race([
        handler.handle(
          new Request(
            new URL("/__progressive-review/submissions", sessionUrl),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-review-token": token,
              },
              body: JSON.stringify({
                submissionId: "submission-1",
                decision: "approve",
                comments: [],
              }),
            },
          ),
        ),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Submission response waited for its hook.")),
            250,
          );
        }),
      ]);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        hook: { configured: true },
      });
    } finally {
      await handler.close();
    }
  });
});
