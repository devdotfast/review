import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../review-test-utils";
import {
  REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import { createReviewSessionHandler } from "./session-handler";
import {
  sessionArtifactFixture,
  sessionArtifactFromBundleDir,
  unusedAgentServices,
} from "./session-handler-test-utils";

afterEach(cleanupTempDirs);

describe("createReviewSessionHandler", () => {
  it("serves the published software map as JSON", async () => {
    const rootPath = await tempDir("review-session-handler-");
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
      artifact: await sessionArtifactFromBundleDir({
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        publicationId: "c".repeat(40),
        bundleDir: rootPath,
        routePath: "/",
        softwareMapRootPath: rootPath,
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
      const rootPath = await tempDir("review-session-handler-");
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
        artifact: await sessionArtifactFromBundleDir({
          reviewUuid,
          publicationId: "c".repeat(40),
          bundleDir: rootPath,
          routePath: "/",
          softwareMapRootPath: rootPath,
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
          error: "This review's software map must be regenerated.",
          detail: { code: "needs_republish", reviewUuid, mapStale: true },
        });
      } finally {
        await handler.close();
      }
    },
  );

  it("reports an unpublished software map when no map root exists", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
});
