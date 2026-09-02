import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ReviewDesktopGlobalEvent } from "@dev.fast/review-protocol";
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

function requestId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop live Review transport", () => {
  it("owns create, render, lifecycle, and open mutations behind authentication", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const server = liveReviewServer(home, handlers);
    let events: Awaited<ReturnType<typeof openReviewEvents>> | undefined;

    try {
      await server.listen();
      const createBody = {
        requestId: requestId(1),
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

      const missingCreateRequestId = await liveJson(
        server.url,
        "/live-reviews",
        {
          cwd: createBody.cwd,
          source: createBody.source,
          title: createBody.title,
        },
      );
      expect(missingCreateRequestId.response.status).toBe(400);

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
      const replayedCreate = await liveRequest(server.url, "/live-reviews", {
        method: "POST",
        body: JSON.stringify(createBody),
      });
      expect(replayedCreate.status).toBe(200);
      await expect(replayedCreate.json()).resolves.toMatchObject({
        info: { reviewId: createResult.info.reviewId },
      });
      expect(handlers).toHaveLength(1);
      const conflictingCreate = await liveJson(server.url, "/live-reviews", {
        ...createBody,
        title: "Different create input",
      });
      expect(conflictingCreate.response.status).toBe(409);
      expect(conflictingCreate.body).toMatchObject({
        code: "review_request_conflict",
      });

      const stored = await findReview(createResult.info.reviewId);
      expect(stored?.review.status).toBe("awaiting-agent-updates");
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });

      const missingRenderRequestId = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        { targetNodeId: "root", mode: "replace", mdx: "Body" },
      );
      expect(missingRenderRequestId.response.status).toBe(400);

      const rejectedBody = {
        requestId: requestId(2),
        targetNodeId: "root",
        mode: "replace",
        mdx: "<UnknownComponent />",
      } as const;
      const rejected = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        rejectedBody,
      );
      expect(rejected.response.status).toBe(422);
      expect(rejected.body).toMatchObject({ ok: false });
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });
      const replayedRejection = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        rejectedBody,
      );
      expect(replayedRejection.response.status).toBe(422);
      expect(replayedRejection.body).toEqual(rejected.body);
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });
      const conflictingRejection = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        { ...rejectedBody, mdx: "Different input" },
      );
      expect(conflictingRejection.response.status).toBe(409);
      expect(conflictingRejection.body).toMatchObject({
        code: "review_request_conflict",
      });
      events = await openReviewEvents(server.url);
      await expect(events.next()).resolves.toEqual({
        event: "review-authoring-target-changed",
        uuid: createResult.info.reviewId,
        target: { targetNodeId: "root", sectionNodeId: null },
      });
      const rejectedWhileConnected = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        {
          requestId: requestId(3),
          targetNodeId: "root",
          mode: "replace",
          mdx: "<StillUnknown />",
        },
      );
      expect(rejectedWhileConnected.response.status).toBe(422);
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        uuid: createResult.info.reviewId,
        target: { targetNodeId: "root", sectionNodeId: null },
      });
      const rootSelection = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/selection`,
      );
      await expect(rootSelection.json()).resolves.toEqual({
        reviewId: createResult.info.reviewId,
        nodeIds: ["root"],
      });

      const appendRequests = ["First", "Second"].map((title, index) => ({
        requestId: requestId(10 + index),
        targetNodeId: "root",
        mode: "append" as const,
        title,
        mdx: `**${title}**`,
      }));
      const appended = await Promise.all(
        appendRequests.map((request) =>
          liveJson(
            server.url,
            `/live-reviews/${createResult.info.reviewId}/render`,
            request,
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
      for (let index = 0; index < 2; index += 1) {
        await expect(events.next()).resolves.toMatchObject({
          event: "review-authoring-target-changed",
          target: { targetNodeId: "root", sectionNodeId: null },
        });
        await expect(events.next()).resolves.toMatchObject({
          event: "review-data-changed",
          uuid: createResult.info.reviewId,
        });
      }
      const replayedAppend = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        appendRequests[0],
      );
      expect(replayedAppend.response.status).toBe(200);
      expect(replayedAppend.body).toEqual(appended[0]!.body);
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        target: { targetNodeId: "root", sectionNodeId: null },
      });
      const conflictingAppend = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        { ...appendRequests[0], mdx: "Different append" },
      );
      expect(conflictingAppend.response.status).toBe(409);
      expect(conflictingAppend.body).toMatchObject({
        code: "review_request_conflict",
      });
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        target: { targetNodeId: "root", sectionNodeId: null },
      });

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
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        target: { targetNodeId: "root", sectionNodeId: null },
      });

      const firstSection = readLiveReviewPage(stored!.dir)!
        .nodes.root!.children.map(
          (nodeId) => readLiveReviewPage(stored!.dir)!.nodes[nodeId]!,
        )
        .find((node) => node.title === "First")!;
      const nested = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        {
          requestId: requestId(20),
          targetNodeId: firstSection.id,
          mode: "append",
          title: "Nested",
          mdx: "Nested body",
        },
      );
      expect(nested.response.status).toBe(200);
      const nestedNodeId = String((nested.body as { nodeId: string }).nodeId);
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        target: {
          targetNodeId: firstSection.id,
          sectionNodeId: firstSection.id,
        },
      });
      await expect(events.next()).resolves.toMatchObject({
        event: "review-data-changed",
      });

      const nestedInfo = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/nodes/${nestedNodeId}`,
      );
      expect(nestedInfo.status).toBe(200);
      await expect(events.next()).resolves.toMatchObject({
        event: "review-authoring-target-changed",
        target: {
          targetNodeId: nestedNodeId,
          sectionNodeId: firstSection.id,
        },
      });
      const nestedSelection = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/selection`,
      );
      await expect(nestedSelection.json()).resolves.toEqual({
        reviewId: createResult.info.reviewId,
        nodeIds: [nestedNodeId],
      });

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
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 3 });

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
        info: { reviewId: createResult.info.reviewId, nodeCount: 4 },
      });

      const missing = await liveRequest(
        server.url,
        "/live-reviews/22222222-2222-4222-8222-222222222222",
      );
      expect(missing.status).toBe(404);
    } finally {
      await events?.close();
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
        requestId: requestId(40),
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

  it("serializes live open attention with lifecycle writes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const server = liveReviewServer(home, []);

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", {
        requestId: requestId(45),
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Attention lock tracer",
      });
      const uuid = String(
        (created.body as { info: { reviewId: string } }).info.reviewId,
      );
      const dismissed = await liveRequest(
        server.url,
        `/reviews/${uuid}/dismiss`,
        { method: "POST" },
      );
      expect(dismissed.status).toBe(200);

      const [status, ...opens] = await Promise.all([
        liveJson(server.url, `/live-reviews/${uuid}/status`, {
          status: "awaiting-review",
        }),
        ...Array.from({ length: 12 }, () =>
          liveRequest(server.url, `/live-reviews/${uuid}/open`, {
            method: "POST",
          }),
        ),
      ]);
      expect(status.response.status).toBe(200);
      expect(opens.every((response) => response.status === 200)).toBe(true);
      const stored = await findReview(uuid);
      expect(stored?.review).toMatchObject({
        status: "awaiting-review",
        dismissedAt: null,
      });
      expect(stored?.review.viewedAt).toEqual(expect.any(String));
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("replays durable create and render receipts after a server restart", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const createBody = {
      requestId: requestId(46),
      cwd: repoRoot,
      source: { kind: "current-checkout" },
      title: "Restart receipt tracer",
    };
    const renderBody = {
      requestId: requestId(47),
      targetNodeId: "root",
      mode: "append",
      title: "One child",
      mdx: "Body",
    };
    let server = liveReviewServer(home, []);

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", createBody);
      const createReceipt = created.body as {
        info: { reviewId: string };
      };
      const uuid = createReceipt.info.reviewId;
      const rendered = await liveJson(
        server.url,
        `/live-reviews/${uuid}/render`,
        renderBody,
      );
      expect(rendered.response.status).toBe(200);
      await server.close("app-exit");

      server = liveReviewServer(home, []);
      await server.listen();
      const replayedCreate = await liveJson(
        server.url,
        "/live-reviews",
        createBody,
      );
      expect(replayedCreate.response.status).toBe(200);
      expect(replayedCreate.body).toMatchObject({
        info: { reviewId: uuid, status: "awaiting-agent" },
      });
      const replayedRender = await liveJson(
        server.url,
        `/live-reviews/${uuid}/render`,
        renderBody,
      );
      expect(replayedRender.response.status).toBe(200);
      expect(replayedRender.body).toEqual(rendered.body);
      const stored = await findReview(uuid);
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 1 });
      expect(
        readLiveReviewPage(stored!.dir)?.nodes.root?.children,
      ).toHaveLength(1);
    } finally {
      await server.close("app-exit");
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
        requestId: requestId(50),
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

async function openReviewEvents(serverUrl: string): Promise<{
  next(): Promise<ReviewDesktopGlobalEvent>;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(`${serverUrl}/events`, {
    headers: { "x-review-token": token },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not open Review events: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<ReviewDesktopGlobalEvent> => {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) return JSON.parse(data) as ReviewDesktopGlobalEvent;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Review event stream ended.");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    next,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
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
