import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_DOCUMENT_BUNDLE_DIR,
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { cleanupTempDirs, tempDir } from "../review-test-utils";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import { legacySessionArtifactFromBuildDir } from "./review-session-artifact";
import { createReviewSessionHandler } from "./session-handler";
import {
  NEEDS_REPUBLISH_ERROR,
  reviewDocument,
  sessionArtifactFixture,
  unusedAgentServices,
} from "./session-handler-test-utils";

afterEach(cleanupTempDirs);

describe("createReviewSessionHandler", () => {
  it("reports a stale map on a missing document even when only the map is unavailable", async () => {
    const rootPath = await tempDir("review-map-stale-");
    const reviewPath = path.join(rootPath, "review.mdx");
    await writeFile(reviewPath, "# Review");
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      artifact: sessionArtifactFixture({
        sourcePath: reviewPath,
        document: { unavailable: NEEDS_REPUBLISH_ERROR },
        map: { unavailable: "Map revision is missing." },
      }),
      routePath: "/",
      token: "secret",
      reviewUuid: "11111111-1111-4111-8111-111111111111",
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: "http://127.0.0.1:5570",
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const response = await handler.handle(
        new Request("http://127.0.0.1:5570/__progressive-review/document", {
          headers: { "x-review-token": "secret" },
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: NEEDS_REPUBLISH_ERROR,
        detail: {
          code: "needs_republish",
          reviewUuid: "11111111-1111-4111-8111-111111111111",
          mapStale: true,
        },
      });
    } finally {
      await handler.close();
    }
  });

  it("serves the version list from the host callback", async () => {
    const rootPath = await tempDir("review-session-handler-");
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
      artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
    const rootPath = await tempDir("review-session-handler-");
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
      artifact: await legacySessionArtifactFromBuildDir({
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        revision: "c".repeat(40),
        buildDir: rootPath,
        routePath: "/",
      }),
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
      const rootPath = await tempDir("review-session-handler-");
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
        artifact: await legacySessionArtifactFromBuildDir({
          reviewUuid,
          revision: "c".repeat(40),
          buildDir: rootPath,
          routePath: "/",
          softwareMapRootPath,
        }),
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
          error: NEEDS_REPUBLISH_ERROR,
          detail: { code: "needs_republish", reviewUuid, mapStale },
        });
      } finally {
        await handler.close();
      }
    },
  );

  it("reports the materialized document's timestamp for a historical session", async () => {
    const reviewDir = await tempDir("review-historical-meta-");
    const revision = "c".repeat(40);
    const buildDir = path.join(reviewDir, ".build", revision);
    const liveReviewPath = path.join(reviewDir, "review.mdx");
    const materializedPath = path.join(buildDir, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    await mkdir(buildDir, { recursive: true });
    await writeFile(materializedPath, "# Published\n", "utf8");
    await writeFile(liveReviewPath, "# Editing\n", "utf8");
    await writeReviewDocumentBundle(
      buildDir,
      bundleReviewDocument(reviewDocument),
    );
    const sealedAt = new Date(1_700_000_000_000);
    await utimes(materializedPath, sealedAt, sealedAt);
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath: reviewDir,
      toolingRoot: reviewDir,
      artifact: await legacySessionArtifactFromBuildDir({
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        revision,
        buildDir,
        routePath: "/",
        historical: true,
      }),
      stateReviewPath: liveReviewPath,
      routePath: "/",
      token,
      session: {
        rootPath: reviewDir,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath: liveReviewPath,
        startedAt: Date.now(),
      },
    });
    const documentMeta = async () =>
      (
        await handler.handle(
          new Request(
            new URL("/__progressive-review/document-meta", sessionUrl),
            {
              headers: { "x-review-token": token },
            },
          ),
        )
      ).json();

    try {
      await expect(documentMeta()).resolves.toMatchObject({
        ok: true,
        updatedAtMs: sealedAt.getTime(),
      });
      // Editing the review's own source must not move a sealed revision's clock.
      const edited = new Date(1_800_000_000_000);
      await utimes(liveReviewPath, edited, edited);
      await expect(documentMeta()).resolves.toMatchObject({
        updatedAtMs: sealedAt.getTime(),
      });
    } finally {
      await handler.close();
    }
  });

  it("fails clearly if needs-republish has no review UUID", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      artifact: sessionArtifactFixture({
        sourcePath: reviewPath,
        document: { unavailable: NEEDS_REPUBLISH_ERROR },
      }),
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
});
