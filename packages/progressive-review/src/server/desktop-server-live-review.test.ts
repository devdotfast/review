import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readLiveReviewPage } from "../live-review-store";
import { findReview } from "../review-home";
import type { ReviewSubmissionEvent } from "../types";
import { createGlobalReviewServer } from "./desktop-server";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const token = "live-review-server-token";

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop live Review transport", () => {
  it("owns create, render, lifecycle, and open mutations behind authentication", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const server = liveReviewServer(home, handlers);

    try {
      await server.listen();
      const createBody = {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Server-owned tracer",
      };
      const unauthorized = await fetch(`${server.url}/live-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createBody),
      });
      expect(unauthorized.status).toBe(401);

      const wrongMediaType = await liveRequest(server.url, "/live-reviews", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(createBody),
      });
      expect(wrongMediaType.status).toBe(415);

      const created = await liveRequest(server.url, "/live-reviews", {
        method: "POST",
        body: JSON.stringify(createBody),
      });
      expect(created.status).toBe(201);
      const createResult = (await created.json()) as {
        sessionId: string;
        info: { reviewId: string; status: string; nodeCount: number };
      };
      expect(createResult.info).toMatchObject({
        status: "awaiting-agent",
        nodeCount: 1,
      });
      expect(handlers).toHaveLength(1);

      const stored = await findReview(createResult.info.reviewId);
      expect(stored?.review.status).toBe("awaiting-agent-updates");
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });

      const rejected = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        {
          targetNodeId: "root",
          mode: "replace",
          mdx: "<UnknownComponent />",
        },
      );
      expect(rejected.response.status).toBe(422);
      expect(rejected.body).toMatchObject({ ok: false });
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });

      const appended = await Promise.all(
        ["First", "Second"].map((title) =>
          liveJson(
            server.url,
            `/live-reviews/${createResult.info.reviewId}/render`,
            {
              targetNodeId: "root",
              mode: "append",
              title,
              mdx: `**${title}**`,
            },
          ),
        ),
      );
      expect(appended.map(({ response }) => response.status)).toEqual([
        200, 200,
      ]);
      expect(
        appended
          .map(({ body }) => Number((body as { version: number }).version))
          .sort(),
      ).toEqual([1, 2]);

      const children = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/nodes/root/children`,
      );
      const childrenBody = (await children.json()) as {
        children: Array<{ parentId: string | null; title?: string }>;
      };
      expect(
        childrenBody.children
          .map(({ parentId, title }) => ({ parentId, title }))
          .sort((left, right) => left.title!.localeCompare(right.title!)),
      ).toEqual([
        { parentId: "root", title: "First" },
        { parentId: "root", title: "Second" },
      ]);

      const forbiddenStatus = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/status`,
        { status: "accepted" },
      );
      expect(forbiddenStatus.response.status).toBe(400);

      const handedOff = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/status`,
        { status: "awaiting-review" },
      );
      expect(handedOff.response.status).toBe(200);
      expect(handedOff.body).toMatchObject({ status: "awaiting-review" });
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 2 });

      await handlers[0]!.onSubmission!(submissionEvent());
      const terminal = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/status`,
        { status: "awaiting-review" },
      );
      expect(terminal.response.status).toBe(409);
      expect(terminal.body).toMatchObject({ code: "review_terminal" });

      const opened = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/open`,
        { method: "POST" },
      );
      expect(opened.status).toBe(200);
      await expect(opened.json()).resolves.toMatchObject({
        sessionId: createResult.sessionId,
        info: { reviewId: createResult.info.reviewId, nodeCount: 3 },
      });

      const missing = await liveRequest(
        server.url,
        "/live-reviews/22222222-2222-4222-8222-222222222222",
      );
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports unexpected persisted-state failures as server errors", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const server = liveReviewServer(home, []);

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Corruption tracer",
      });
      const uuid = String(
        (created.body as { info: { reviewId: string } }).info.reviewId,
      );
      const stored = await findReview(uuid);
      await writeFile(path.join(stored!.dir, "review.json"), "not json\n");

      const response = await liveRequest(server.url, `/live-reviews/${uuid}`);
      expect(response.status).toBe(500);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rolls back persistence when the create-and-open bootstrap cannot register", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      sessionHandlerFactory: async () => {
        throw new Error("canvas registration failed");
      },
    });

    try {
      await server.listen();
      const response = await liveJson(server.url, "/live-reviews", {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Rollback tracer",
      });
      expect(response.response.status).toBe(500);

      const listed = await liveRequest(
        server.url,
        `/live-reviews?cwd=${encodeURIComponent(repoRoot)}`,
      );
      await expect(listed.json()).resolves.toEqual({ reviews: [] });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function liveReviewServer(home: string, handlers: ReviewSessionHandlerInput[]) {
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
  });
}

function stubSessionHandler(): ReviewSessionHandler {
  return {
    token,
    handle: async () => new Response("not found", { status: 404 }),
    findAgentThread: () => undefined,
    close: async () => undefined,
  };
}

function liveRequest(
  serverUrl: string,
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-review-token", token);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${serverUrl}${route}`, { ...init, headers });
}

async function liveJson(
  serverUrl: string,
  route: string,
  body: unknown,
): Promise<{ response: Response; body: unknown }> {
  const response = await liveRequest(serverUrl, route, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function submissionEvent(): ReviewSubmissionEvent {
  return {
    id: "live-review-submission",
    decision: "approve",
    createdAt: "2026-09-02T12:00:00.000Z",
    rootPath: repoRoot,
    reviewPath: "review.mdx",
    documentRoute: "/",
    comments: [],
    prompt: "Approve the live Review.",
  };
}
