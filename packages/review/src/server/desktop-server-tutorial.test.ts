import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, isJsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { materializePublishRevision } from "../publish-stage";
import { findReview } from "../review-home";
import { createGlobalReviewServer } from "./desktop-server";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const token = "tutorial-test-token";

type GlobalServerInput = Parameters<typeof createGlobalReviewServer>[0];

type TutorialServerOverrides = Partial<
  Pick<GlobalServerInput, "publishRuntime" | "sessionHandlerFactory">
>;

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop tutorial preparation", () => {
  it("prepares locally and opens without an installed agent", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );

    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const server = tutorialServer(home, handlers);

    try {
      await server.listen();

      const [preparedA, preparedB] = await Promise.all([
        tutorialRequest(server.url, "/tutorial/prepare", "POST"),
        tutorialRequest(server.url, "/tutorial/prepare", "POST"),
      ]);

      expect(preparedA.status).toBe(200);
      expect(preparedB.status).toBe(200);

      const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.session.agent).toBeUndefined();
      await expect(
        findReview(String(opened.reviewUuid)),
      ).resolves.toMatchObject({
        review: { sourceSession: "disabled:review" },
      });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("repairs missing cached artifacts and self-heals after generic deletion", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );

    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const close = vi.fn<ReviewSessionHandler["close"]>(async () => undefined);

    const server = tutorialServer(home, handlers, {
      sessionHandlerFactory: async (input) => {
        handlers.push(input);

        return { ...stubSessionHandler(), close };
      },
    });

    try {
      await server.listen();
      const first = await tutorialJson(server.url, "/tutorial/open", "POST");
      const firstHandler = handlers[0];
      expect(firstHandler).toBeDefined();
      await rm(firstHandler!.reviewPath, { force: true });

      const repaired = await tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );

      expect(repaired.status).toBe(200);
      expect(existsSync(firstHandler!.reviewPath)).toBe(true);
      expect(close).toHaveBeenCalledOnce();

      await tutorialRequest(server.url, "/tutorial/open", "POST");
      expect(handlers).toHaveLength(2);
      const repairedHandler = handlers[1];
      expect(repairedHandler).toBeDefined();
      expect(repairedHandler).not.toBe(firstHandler);
      await rm(repairedHandler!.session.headRootPath!, {
        recursive: true,
        force: true,
      });

      const checkoutRepaired = await tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );

      expect(checkoutRepaired.status).toBe(200);
      expect(existsSync(repairedHandler!.session.headRootPath!)).toBe(true);

      const deleted = await tutorialRequest(
        server.url,
        `/reviews/${String(first.reviewUuid)}`,
        "DELETE",
      );

      expect(deleted.status).toBe(200);
      await expect(findReview(String(first.reviewUuid))).resolves.toBeNull();

      const second = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(second.reviewUuid).not.toBe(first.reviewUuid);
      const secondHandler = handlers.at(-1);
      expect(secondHandler).toBeDefined();
      expect(existsSync(secondHandler!.reviewPath)).toBe(true);
      expect(existsSync(secondHandler!.session.baseRootPath!)).toBe(true);
      expect(existsSync(secondHandler!.session.headRootPath!)).toBe(true);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("orders prepare, delete, and a following prepare without partial state", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );

    vi.stubEnv("DEV_REVIEW_HOME", home);
    let release!: () => void;
    let entered!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    let blockFirst = true;

    const server = tutorialServer(home, [], {
      publishRuntime: {
        materializePublishRevision: async (input) => {
          if (blockFirst) {
            blockFirst = false;
            entered();
            await gate;
          }

          return materializePublishRevision(input);
        },
      },
    });

    try {
      await server.listen();
      const unrelatedUuid = "22222222-2222-4222-8222-222222222222";
      await mkdir(path.join(home, "reviews", unrelatedUuid), {
        recursive: true,
      });

      const firstPrepare = tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );

      await started;

      const unrelatedDeletion = tutorialRequest(
        server.url,
        `/reviews/${unrelatedUuid}`,
        "DELETE",
      );

      await expect(
        Promise.race([
          unrelatedDeletion,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("unrelated delete was blocked")),
              500,
            ),
          ),
        ]),
      ).resolves.toMatchObject({ status: 200 });
      const deletion = tutorialRequest(server.url, "/tutorial", "DELETE");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondPrepare = tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );

      release();

      const first = await responseJson(firstPrepare);
      expect((await deletion).status).toBe(200);
      const second = await responseJson(secondPrepare);
      expect(second.reviewUuid).not.toBe(first.reviewUuid);
      await expect(findReview(String(first.reviewUuid))).resolves.toBeNull();
      await expect(
        findReview(String(second.reviewUuid)),
      ).resolves.not.toBeNull();
    } finally {
      release();
      await server.close();
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
  expect(resolved.status).toBe(200);
  const body = await resolved.json();

  if (!isJsonObject(body)) {
    throw new Error("Expected a JSON object response body.");
  }

  return body;
}
