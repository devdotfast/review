import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, isJsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { elements } from "../review-api/document";
import { openLocalReviewStore } from "../review-api/local-data";
import { createGlobalReviewServer } from "./desktop-server";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const token = "tutorial-test-token";

type GlobalServerInput = Parameters<typeof createGlobalReviewServer>[0];

type TutorialServerOverrides = Partial<
  Pick<
    GlobalServerInput,
    "publishRuntime" | "sessionHandlerFactory" | "reviewStore" | "reviewData"
  >
>;

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop tutorial preparation", () => {
  it("opens a prepared native tutorial into the JSON canvas with interactive content, pins and resources", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-json-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    const local = openLocalReviewStore(path.join(home, "review-api.db"));

    const original = await createTutorialService({
      packageRoot,
      ...local,
    }).prepare();

    const handlers: ReviewSessionHandlerInput[] = [];

    const server = tutorialServer(home, handlers, {
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
      expect(handlers).toHaveLength(0);
      const snapshot = local.store.read(original.reviewId);
      expect(snapshot.pins).toMatchObject({
        base: original.pins.base,
        head: original.pins.head,
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
      expect(
        (
          await tutorialRequest(
            server.url,
            `/reviews/${String(fresh.reviewUuid)}`,
            "DELETE",
          )
        ).status,
      ).toBe(200);
      expect(local.store.has(String(fresh.reviewUuid))).toBe(false);
      expect(
        (await tutorialJson(server.url, "/tutorial/open", "POST")).reviewUuid,
      ).not.toBe(fresh.reviewUuid);
    } finally {
      await server.close();
      await local.data.close();
      await local.store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function tutorialServer(
  home: string,
  handlers: ReviewSessionHandlerInput[],
  overrides: TutorialServerOverrides = {},
) {
  return createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
    sessionHandlerFactory: async (input) => {
      handlers.push(input);

      return stubSessionHandler();
    },
    ...overrides,
  });
}

function stubSessionHandler(): ReviewSessionHandler {
  return {
    token,
    handle: async () => new Response("not found", { status: 404 }),
    close: async () => undefined,
  };
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
