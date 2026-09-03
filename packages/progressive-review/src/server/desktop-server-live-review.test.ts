import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readLiveReviewPage } from "../live-review-store";
import { ProgressiveReviewTelemetry } from "../progressive-review-telemetry";
import { findReview } from "../review-home";
import type { ReviewSubmissionEvent } from "../types";
import { createGlobalReviewServer } from "./desktop-server";
import type { ReviewStateEvent } from "./review-state-service";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

vi.mock("../review-agent-traces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../review-agent-traces")>();
  return {
    ...actual,
    loadReviewAgentTrace: async (input: { sessionId: string }) =>
      input.sessionId === "live-trace"
        ? ({
            trace: {
              events: [
                {
                  kind: "user",
                  text: "Keep the trace interactive.",
                  at: "2026-09-02T00:00:00Z",
                },
              ],
            },
          } as NonNullable<
            Awaited<ReturnType<typeof actual.loadReviewAgentTrace>>
          >)
        : actual.loadReviewAgentTrace(input),
  };
});

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const token = "live-review-server-token";

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop live Review transport", () => {
  it("renders a validated interactive database lens from live MDX", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const server = liveReviewServer(home, []);

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Database tracer",
      });
      const uuid = String(
        (created.body as { info: { reviewId: string } }).info.reviewId,
      );
      const initialStateResponse = await liveRequest(
        server.url,
        `/live-reviews/${uuid}/state`,
      );
      const initialState = await initialStateResponse.json();
      expect(initialStateResponse.status).toBe(200);
      expect(initialState).toMatchObject({
        ok: true,
        state: {
          page: { id: uuid, rootNodeId: "root", version: 0 },
          authoringTarget: null,
        },
      });
      const rendered = await liveJson(
        server.url,
        `/live-reviews/${uuid}/render`,
        {
          targetNodeId: "root",
          mode: "append",
          title: "Persisted state",
          mdx: `
<DatabaseLens
  title="Thread storage"
  stores={{ reviewDb: { kind: "relational", label: "review.db", tables: { threads: { key: "id", schema: { id: { type: "text", pk: true }, agentSessionId: { type: "text" } } } } } }}
  height={440}
>
  <DbUseCase id="bind-session" label="Bind an agent session">
    <DbWrite
      from={{ id: "reviewApi", label: "Review API" }}
      to={{ store: "reviewDb", collectionKind: "tables", collection: "threads", path: ["agentSessionId"] }}
      label="persist session binding"
      anchor={{ peek: { file: "package.json", fromLine: 1, toLine: 3 } }}
    />
  </DbUseCase>
</DatabaseLens>`,
        },
      );
      expect(rendered.response.status).toBe(200);
      const updatedStateResponse = await liveRequest(
        server.url,
        `/live-reviews/${uuid}/state`,
      );
      expect(await updatedStateResponse.json()).toMatchObject({
        ok: true,
        state: {
          page: { id: uuid, version: 1 },
          authoringTarget: { targetNodeId: "root", sectionNodeId: null },
        },
      });
      const stored = await findReview(uuid);
      const page = readLiveReviewPage(stored!.dir)!;
      expect(Object.values(page.projection.elements)).toContainEqual(
        expect.objectContaining({
          type: "DatabaseLens",
          props: expect.objectContaining({
            title: "Thread storage",
            useCases: [
              expect.objectContaining({
                id: "bind-session",
                operations: [
                  expect.objectContaining({
                    kind: "write",
                    label: "persist session binding",
                    anchor: expect.objectContaining({
                      __kind: "db-anchor-ref",
                    }),
                  }),
                ],
              }),
            ],
          }),
        }),
      );

      const reused = await liveJson(
        server.url,
        `/live-reviews/${uuid}/render`,
        {
          targetNodeId: "root",
          mode: "append",
          title: "Shared evidence",
          mdx: `
<SequenceDiagram label="First use" messages={[{
  from: { label: "Agent" },
  to: { label: "Desktop" },
  label: "open source",
  anchor: { id: "shared-source", title: "Shared source", peek: { file: "package.json", fromLine: 1, toLine: 3 } }
}]} />

<SequenceDiagram label="Second use" messages={[{
  from: { label: "Desktop" },
  to: { label: "Agent" },
  label: "show source",
  anchor: { id: "shared-source", title: "Shared source", peek: { file: "package.json", fromLine: 1, toLine: 3 } }
}]} />

Open <AnchorLink anchor={{ id: "shared-source", title: "Shared source", peek: { file: "package.json", fromLine: 1, toLine: 3 } }}>the shared source</AnchorLink> in the side peek. <TraceQuote sessionId="live-trace" event={0}>Keep the trace interactive.</TraceQuote>

<CodePeek anchor={{ id: "shared-source", title: "Shared source", peek: { file: "package.json", fromLine: 1, toLine: 3 } }} />`,
        },
      );
      expect(reused.response.status).toBe(200);
      const reusedPage = readLiveReviewPage(stored!.dir)!;
      expect(reusedPage).toMatchObject({ version: 2 });
      expect(Object.values(reusedPage.projection.elements)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "Markdown",
            props: expect.objectContaining({
              links: expect.objectContaining({
                "link-1": expect.objectContaining({ kind: "anchor" }),
                "link-2": expect.objectContaining({ kind: "trace-quote" }),
              }),
            }),
          }),
          expect.objectContaining({
            type: "CodePeek",
            props: expect.objectContaining({
              anchor: expect.objectContaining({ id: "shared-source" }),
            }),
          }),
        ]),
      );

      const conflicting = await liveJson(
        server.url,
        `/live-reviews/${uuid}/render`,
        {
          targetNodeId: "root",
          mode: "append",
          title: "Conflicting evidence",
          mdx: `<SequenceDiagram label="Conflict" messages={[{
  from: { label: "Agent" },
  to: { label: "Desktop" },
  label: "open different source",
  anchor: { id: "shared-source", title: "Shared source", peek: { file: "package.json", fromLine: 1, toLine: 4 } }
}]} />`,
        },
      );
      expect(conflicting.response.status).toBe(422);
      expect(conflicting.body).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            message:
              "Anchor ID is reused with different source or metadata: shared-source",
          }),
        ],
      });
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 2 });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("owns create, render, lifecycle, and open mutations behind authentication", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const server = liveReviewServer(home, handlers);
    let events: Awaited<ReturnType<typeof openReviewEvents>> | undefined;

    try {
      await server.listen();
      const createBody = {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Server-owned tracer",
        agent: { harness: "codex", sessionId: "source-thread" },
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
      expect(stored?.review.sourceSession).toBe("codex:source-thread");
      expect(stored?.review.agentSessions).toMatchObject({
        "codex:source-thread": { roles: ["author"] },
      });
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });

      const rejectedBody = {
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
      events = await openReviewEvents(server.url, createResult.info.reviewId);
      await expect(events.next()).resolves.toEqual({
        type: "state.snapshot",
        state: expect.objectContaining({
          authoringTarget: { targetNodeId: "root", sectionNodeId: null },
        }),
      });
      const rejectedWhileConnected = await liveJson(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/render`,
        {
          targetNodeId: "root",
          mode: "replace",
          mdx: "<StillUnknown />",
        },
      );
      expect(rejectedWhileConnected.response.status).toBe(422);
      expect(readLiveReviewPage(stored!.dir)).toMatchObject({ version: 0 });
      await expect(events.next()).resolves.toMatchObject({
        type: "authoring-target.changed",
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

      const appendRequests = ["First", "Second"].map((title) => ({
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
          type: "authoring-target.changed",
          target: { targetNodeId: "root", sectionNodeId: null },
        });
        await expect(events.next()).resolves.toMatchObject({
          type: "document.committed",
        });
      }
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
        type: "authoring-target.changed",
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
          targetNodeId: firstSection.id,
          mode: "append",
          title: "Nested",
          mdx: "Nested body",
        },
      );
      expect(nested.response.status).toBe(200);
      const nestedNodeId = String((nested.body as { nodeId: string }).nodeId);
      await expect(events.next()).resolves.toMatchObject({
        type: "authoring-target.changed",
        target: {
          targetNodeId: firstSection.id,
          sectionNodeId: firstSection.id,
        },
      });
      await expect(events.next()).resolves.toMatchObject({
        type: "document.committed",
      });

      const nestedInfo = await liveRequest(
        server.url,
        `/live-reviews/${createResult.info.reviewId}/nodes/${nestedNodeId}`,
      );
      expect(nestedInfo.status).toBe(200);
      await expect(events.next()).resolves.toMatchObject({
        type: "authoring-target.changed",
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
  }, 15_000);

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

  it("serializes live open attention with lifecycle writes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const server = liveReviewServer(home, []);

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", {
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

  it("installs the latest lifecycle state when open races a status write", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "live-review-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const telemetry = new ProgressiveReviewTelemetry({
      env: { ...process.env, DO_NOT_TRACK: "1" },
    });
    const openReachedTelemetry = deferred();
    const releaseOpen = deferred();
    let pauseRestoredOpen = false;
    vi.spyOn(telemetry, "captureUiEvent").mockImplementation(async (event) => {
      if (pauseRestoredOpen && event === "review_review_restored") {
        openReachedTelemetry.resolve();
        await releaseOpen.promise;
      }
    });
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      telemetry,
      sessionHandlerFactory: async (input) => {
        handlers.push(input);
        return stubSessionHandler();
      },
    });

    try {
      await server.listen();
      const created = await liveJson(server.url, "/live-reviews", {
        cwd: repoRoot,
        source: { kind: "current-checkout" },
        title: "Open state race tracer",
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

      pauseRestoredOpen = true;
      const opening = liveRequest(server.url, `/live-reviews/${uuid}/open`, {
        method: "POST",
      });
      await openReachedTelemetry.promise;
      const status = await liveJson(
        server.url,
        `/live-reviews/${uuid}/status`,
        { status: "awaiting-review" },
      );
      expect(status.response.status).toBe(200);
      releaseOpen.resolve();

      expect((await opening).status).toBe(200);
      expect((await findReview(uuid))?.review.status).toBe("awaiting-review");
      expect(handlers).toHaveLength(1);
      expect(handlers[0]!.getReviewStatus?.()).toBe("awaiting-review");
    } finally {
      releaseOpen.resolve();
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

async function openReviewEvents(
  serverUrl: string,
  reviewId: string,
): Promise<{
  next(): Promise<ReviewStateEvent>;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(
    `${serverUrl}/live-reviews/${reviewId}/state/events`,
    {
      headers: { "x-review-token": token },
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Could not open Review events: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<ReviewStateEvent> => {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) return JSON.parse(data) as ReviewStateEvent;
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
