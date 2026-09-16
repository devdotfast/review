import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type JsonObject, jsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { scratchGitRepo } from "../review-import/import-test-utils";
import type { LegacyImporter } from "../review-import/legacy-importer";
import { reviewVcs } from "../review-vcs";
import {
  type GlobalReviewServer,
  createGlobalReviewServer,
} from "./desktop-server";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay";

const packageRoot = path.resolve(import.meta.dirname, "../..");

const uuid = "22222222-2222-4222-8222-222222222222";

const token = "import-secret";

let directory: string | undefined;

let server: GlobalReviewServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();

  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function seedLegacyReview() {
  directory = await mkdtemp(path.join(tmpdir(), "review-import-server-"));
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  await writeFile(
    path.join(directory, "preferences.json"),
    JSON.stringify({ dismissedRetentionDays: null }),
  );
  const repo = await scratchGitRepo();
  const dir = path.join(directory, "reviews", uuid);
  await mkdir(dir, { recursive: true });
  await reviewVcs.init(dir);
  await writeFile(path.join(dir, "review.mdx"), "# Imported\n");
  await writeFile(path.join(dir, ".gitignore"), ".build/\nreview.db*\n");

  const base = {
    schemaVersion: 5,
    uuid,
    repoKey: "repo",
    worktreePath: repo.root,
    baseRef: "main",
    baseCommit: repo.base,
    sourceCommit: repo.head,
    sourceIdentity: null,
    title: "Imported",
    sourceSession: "disabled:review",
    status: "awaiting-review",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt: "2026-09-01T00:00:00Z",
    lastPublishedAt: "2026-09-01T00:00:00Z",
  };

  await writeFile(path.join(dir, "review.json"), JSON.stringify(base));
  const revision = await reviewVcs.seal(dir, "Review publish candidate");
  await writeFile(
    path.join(dir, "review.json"),
    JSON.stringify({ ...base, presentedDocumentRevision: revision }),
  );

  return { dir, repo, revision, home: directory };
}

const request = async (route: string, body?: JsonObject) => {
  const response = await fetch(`${server!.url}${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-review-token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: response.status, value: jsonObject(await response.json()) };
};

describe("legacy review import triggers", () => {
  it("opens an imported review in the JSON canvas and answers `imported`", async () => {
    const { home } = await seedLegacyReview();
    const dispatched: string[] = [];
    const relay = new GlobalReviewDesktopVerbRelay();

    relay.dispatch = async (_sessionId, verb) => {
      dispatched.push(String(jsonObject(verb)?.name));

      return { ok: true };
    };

    const importer: LegacyImporter = {
      sweep: async () => [],
      ensure: async (review) => ({
        kind: "imported",
        reviewId: review.review.uuid,
        title: review.review.title,
        version: 0,
        warnings: [],
      }),
    };

    server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      relay,
      legacyImporter: importer,
    });
    await server.listen();

    const opened = await request(`/reviews/${uuid}/open`, {});
    expect(opened.status).toBe(409);
    expect(opened.value).toMatchObject({ ok: false, code: "imported" });
    expect(dispatched).toEqual(["openApiReview"]);
  });

  it("fails the open and keeps the legacy session when the Desktop cannot open the review", async () => {
    const { home } = await seedLegacyReview();
    const relay = new GlobalReviewDesktopVerbRelay();
    relay.dispatch = async () => ({ ok: false, error: "reloading" });

    server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      relay,
      legacyImporter: {
        sweep: async () => [],
        ensure: async () => ({ kind: "current", reviewId: uuid }),
      },
    });
    await server.listen();

    const opened = await request(`/reviews/${uuid}/open`, {});
    expect(opened.status).toBe(503);
    expect(opened.value).toMatchObject({
      ok: false,
      code: "desktop_unavailable",
    });
  });

  it("falls through to the legacy open when the import is skipped", async () => {
    const { home } = await seedLegacyReview();
    const dispatched: string[] = [];
    const relay = new GlobalReviewDesktopVerbRelay();

    relay.dispatch = async (_sessionId, verb) => {
      dispatched.push(String(jsonObject(verb)?.name));

      return { ok: true };
    };

    server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      relay,
      legacyImporter: {
        sweep: async () => [],
        ensure: async (review) => ({
          kind: "skipped",
          reviewId: review.review.uuid,
          reason: "never published",
        }),
      },
    });
    await server.listen();

    const opened = await request(`/reviews/${uuid}/open`, {});
    expect(opened.value?.code).not.toBe("imported");
    expect(dispatched).not.toContain("openApiReview");
  });

  it("lists without waiting for the sweep and hides imported reviews", async () => {
    const { home, repo, revision } = await seedLegacyReview();

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    const sweep = vi.fn<LegacyImporter["sweep"]>(() => new Promise(() => {}));

    try {
      const registered = await data.register(repo.root);
      await store.importVersion({
        reviewId: uuid,
        title: "Imported",
        pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
        document: [],
        createdAt: "2026-09-01T00:00:00Z",
        origin: { revision },
      });

      server = createGlobalReviewServer({
        appPid: process.pid,
        packageRoot,
        toolingRoot: packageRoot,
        port: 0,
        token,
        discoveryPath: path.join(home, "desktop.json"),
        reviewStore: store,
        reviewData: data,
        legacyImporter: {
          sweep,
          ensure: async () => ({ kind: "current", reviewId: uuid }),
        },
      });
      await server.listen();

      const listed = await request("/reviews");
      expect(listed.status).toBe(200);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(
        (listed.value?.reviews as { uuid: string }[]).some(
          (review) => review.uuid === uuid,
        ),
      ).toBe(false);
    } finally {
      await server?.close();
      server = undefined;
      await store.close();
    }
  });

  it("refuses publish, map publish and repair for an imported review", async () => {
    const { home, repo, revision } = await seedLegacyReview();

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const registered = await data.register(repo.root);
      await store.importVersion({
        reviewId: uuid,
        title: "Imported",
        pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
        document: [],
        createdAt: "2026-09-01T00:00:00Z",
        origin: { revision },
      });

      server = createGlobalReviewServer({
        appPid: process.pid,
        packageRoot,
        toolingRoot: packageRoot,
        port: 0,
        token,
        discoveryPath: path.join(home, "desktop.json"),
        reviewStore: store,
        reviewData: data,
        legacyImporter: {
          sweep: async () => [],
          ensure: async () => ({ kind: "current", reviewId: uuid }),
        },
      });
      await server.listen();

      const bodies: [string, string, JsonObject][] = [
        ["/publish-ready", "publish", { reviewUuid: uuid, revision }],
        ["/map-publish-ready", "map publish", { reviewUuid: uuid, revision }],
        [
          "/repair-ready",
          "repair",
          {
            reviewUuid: uuid,
            stagingDir: repo.root,
            expectedRecord: "{}",
            expectedFingerprint: "0".repeat(64),
            newDocumentRevision: revision,
            newMapRevision: null,
            sourceFallback: { document: false, map: false },
          },
        ],
      ];

      for (const [route, verb, body] of bodies) {
        const refused = await request(route, body);

        expect(refused.status).toBe(409);
        expect(refused.value).toMatchObject({
          ok: false,
          code: "migrated",
          error: expect.stringMatching(
            new RegExp(
              `migrated to the JSON review store\\. \`review ${verb}\``,
            ),
          ),
        });
      }
    } finally {
      await server?.close();
      server = undefined;
      await store.close();
    }
  });
});
