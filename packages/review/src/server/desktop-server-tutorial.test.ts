import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, isJsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { elements } from "../review-api/document";
import { openLocalReviewStore } from "../review-api/local-data";
import { createGlobalReviewServer } from "./desktop-server";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const token = "tutorial-test-token";

type GlobalServerInput = Parameters<typeof createGlobalReviewServer>[0];

type TutorialServerOverrides = Pick<
  GlobalServerInput,
  "reviewStore" | "reviewData"
>;

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop tutorial preparation", () => {
  it("serves native reviews while removed session and publishing routes return 404", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-native-routes-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const local = openLocalReviewStore(path.join(home, "review-api.db"));

    const server = tutorialServer(home, {
      reviewStore: local.store,
      reviewData: local.data,
    });

    try {
      await server.listen();

      const headers = {
        "x-review-token": token,
        "content-type": "application/json",
      };

      const catalog = await fetch(`${server.url}/sessions-api`, { headers });
      expect(catalog.status).toBe(200);
      // The scratchpad is off by default; there are no reviews yet.
      expect(await catalog.json()).toEqual([]);

      for (const route of [
        "/reviews-api",
        "/reviews-api/commands",
        "/reviews-api/old/report",
      ]) {
        const response = await fetch(`${server.url}${route}`, {
          headers,
          method: "POST",
          body: "{}",
        });

        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
          code: "review_renamed",
        });
      }

      for (const route of [
        "/reviews",
        "/sessions",
        "/sessions/old",
        "/reviews/old/publish",
        "/reviews/old/repair",
        "/reviews/old/map/publish",
      ]) {
        for (const method of ["GET", "POST"]) {
          const response = await fetch(`${server.url}${route}`, {
            headers,
            method,
          });

          expect(response.status, `${method} ${route}`).toBe(404);
        }
      }

      // The removed routes wrote nothing.
      expect(local.store.list()).toEqual([]);
    } finally {
      await server.close();
      await local.data.close();
      await local.store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("opens a prepared native tutorial into the JSON canvas with interactive content, pins and resources", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-json-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    const local = openLocalReviewStore(path.join(home, "review-api.db"));

    const original = await createTutorialService({
      packageRoot,
      ...local,
    }).prepare();

    const server = tutorialServer(home, {
      reviewStore: local.store,
      reviewData: local.data,
    });

    try {
      await server.listen();

      const [preparedA, preparedB] = await Promise.all([
        tutorialJson(server.url, "/tutorial/prepare", "POST"),
        tutorialJson(server.url, "/tutorial/prepare", "POST"),
      ]);

      expect(preparedA.reviewUuid).toBe(original.reviewId);
      expect(preparedB.reviewUuid).toBe(original.reviewId);
      const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(opened).toMatchObject({
        kind: "api",
        reviewUuid: original.reviewId,
      });
      const snapshot = local.store.read(original.reviewId);
      expect(snapshot.pins).toMatchObject({
        base: original.pins!.base,
        head: original.pins!.head,
      });
      expect(snapshot.origin?.tutorial).toBe(true);
      expect(local.store.list()).toEqual([]);
      const blocks = elements(snapshot.document);
      expect(
        blocks.filter((b) => b.type === "tutorial").map((b) => b.kind),
      ).toEqual(
        expect.arrayContaining(["conversation", "keymap", "view", "feature"]),
      );
      expect(blocks.some((b) => b.type === "code_peek")).toBe(true);
      expect(blocks.some((b) => b.type === "sequence")).toBe(true);
      expect(blocks.some((b) => b.type === "database_lens")).toBe(true);
      expect(blocks.some((b) => b.type === "trace_quote")).toBe(true);
      expect(blocks.some((b) => b.type === "software_map")).toBe(true);
      expect(
        blocks.some((b) => b.type === "section" && b.title === "Software map"),
      ).toBe(false);
      const repeated = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(repeated.reviewUuid).toBe(original.reviewId);
      expect(local.store.read(original.reviewId)).toEqual(snapshot);
      expect(
        (await tutorialRequest(server.url, "/tutorial", "DELETE")).status,
      ).toBe(200);
      expect(local.store.has(original.reviewId)).toBe(false);
      const fresh = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(fresh.kind).toBe("api");
      expect(fresh.reviewUuid).not.toBe(original.reviewId);
      expect(local.store.list()).toEqual([]);
    } finally {
      await server.close();
      await local.data.close();
      await local.store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function tutorialServer(home: string, overrides: TutorialServerOverrides) {
  return createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
    ...overrides,
  });
}

function tutorialRequest(
  serverUrl: string,
  route: string,
  method: "POST" | "DELETE",
): Promise<Response> {
  return fetch(`${serverUrl}${route}`, {
    method,
    headers: { "x-review-token": token },
  });
}

function tutorialJson(
  serverUrl: string,
  route: string,
  method: "POST",
): Promise<JsonObject> {
  return responseJson(tutorialRequest(serverUrl, route, method));
}

async function responseJson(response: Promise<Response>): Promise<JsonObject> {
  const resolved = await response;

  if (!resolved.ok) throw new Error(await resolved.text());
  expect(resolved.status).toBe(200);
  const body = await resolved.json();

  if (!isJsonObject(body)) {
    throw new Error("Expected a JSON object response body.");
  }

  return body;
}
