import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendReviewComment,
  appendReviewCommentDraft,
} from "../review-state-store";
import { runReviewThreadsGet } from "../threads-cli";
import {
  type ReviewSessionHandler,
  type ReviewSessionHandlerInput,
  createReviewSessionHandler,
} from "./session-handler";

const REVIEW_TOKEN = "session-secret";
const LAUNCH_ID = "test-launch";
const SESSION_PATH = "/sessions/test-session";
const API_PREFIX = "/__progressive-review";

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

let rootPath: string | undefined;
let server: Server | undefined;
let handler: ReviewSessionHandler | undefined;

afterEach(async () => {
  if (handler) await handler.close();
  handler = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  if (rootPath) await rm(rootPath, { recursive: true, force: true });
  rootPath = undefined;
});

/**
 * The native-agent thread GET route is the only documented channel that surfaces
 * an in-flight draft thread record (target + complete message list) to a
 * launched Review agent. These tests re-establish the contract the
 * `dev-review-thread-id:` skill documents as canonical context.
 */
describe("GET /native-agent-events/:launchId/thread/:threadId", () => {
  it("returns the in-flight draft thread (state draft) with target and messages", async () => {
    const { sessionUrl, reviewPath } = await spinUpHandler();
    appendReviewCommentDraft(reviewPath, {
      threadId: "thread-draft",
      messageId: "message-draft",
      target: { kind: "document" },
      body: "What does this block do?",
      author: "Reviewer",
    });

    const response = await handler!.handle(
      new Request(
        new URL(
          `${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread/thread-draft`,
          sessionUrl,
        ),
        { headers: { "x-review-token": REVIEW_TOKEN } },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      review: path.basename(rootPath!),
      state: "draft",
      comment: {
        threadId: "thread-draft",
        target: { kind: "document" },
        status: "open",
        messages: [
          {
            id: "message-draft",
            by: "Reviewer",
            body: "What does this block do?",
          },
        ],
      },
    });
  });

  it("returns a submitted thread with state submitted when no draft exists", async () => {
    const { sessionUrl, reviewPath } = await spinUpHandler();
    appendReviewComment(reviewPath, {
      threadId: "thread-submitted",
      messageId: "message-submitted",
      target: { kind: "document" },
      body: "Please fix.",
      author: "Reviewer",
    });

    const response = await handler!.handle(
      new Request(
        new URL(
          `${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread/thread-submitted`,
          sessionUrl,
        ),
        { headers: { "x-review-token": REVIEW_TOKEN } },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      review: path.basename(rootPath!),
      state: "submitted",
      comment: { threadId: "thread-submitted", target: { kind: "document" } },
    });
  });

  it("prefers the draft when both a draft and a submitted comment exist", async () => {
    // Submission promotes drafts into the comments store and clears drafts, so
    // the two stores are disjoint in steady state. While both exist (a reviewer
    // followed up before the prior draft was submitted) the route must mirror
    // `draft?.thread ?? comment`, which carries the in-flight message list.
    const { sessionUrl, reviewPath } = await spinUpHandler();
    appendReviewComment(reviewPath, {
      threadId: "thread-both",
      messageId: "message-1",
      target: { kind: "document" },
      body: "Initial question",
      author: "Reviewer",
    });
    appendReviewCommentDraft(reviewPath, {
      threadId: "thread-both",
      messageId: "message-2",
      target: { kind: "document" },
      body: "Follow-up question",
      author: "Reviewer",
    });

    const response = await handler!.handle(
      new Request(
        new URL(
          `${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread/thread-both`,
          sessionUrl,
        ),
        { headers: { "x-review-token": REVIEW_TOKEN } },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "draft",
      comment: {
        threadId: "thread-both",
        messages: [
          { id: "message-1", body: "Initial question" },
          { id: "message-2", body: "Follow-up question" },
        ],
      },
    });
  });

  it("responds 404 with `Comment thread not found: <threadId>` for an unknown thread", async () => {
    const { sessionUrl } = await spinUpHandler();
    const response = await handler!.handle(
      new Request(
        new URL(
          `${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread/missing`,
          sessionUrl,
        ),
        { headers: { "x-review-token": REVIEW_TOKEN } },
      ),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Comment thread not found: missing",
    });
  });

  it("requires the review token (401 without it)", async () => {
    const { sessionUrl } = await spinUpHandler();
    // The route sits under the `${API_PREFIX}/*` auth middleware, so a launched
    // agent must present the token the launcher wired into its environment.
    const response = await handler!.handle(
      new Request(
        new URL(
          `${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread/thread-draft`,
          sessionUrl,
        ),
      ),
    );
    expect(response.status).toBe(401);
  });

  it("leaves the POST /native-agent-events/:launchId hook route intact", async () => {
    // Re-adding the GET route must not shadow the live event hook the launcher
    // relies on for native agent session observation.
    const { sessionUrl } = await spinUpHandler();
    const response = await handler!.handle(
      new Request(
        new URL(`${API_PREFIX}/native-agent-events/${LAUNCH_ID}`, sessionUrl),
        {
          method: "POST",
          headers: {
            "x-review-token": REVIEW_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ event: "SessionStart" }),
        },
      ),
    );
    expect(response.status).toBe(200);
  });

  it("lets `review threads get` read an in-flight draft through the launcher's env", async () => {
    // End-to-end: the launcher sets `DEV_FAST_REVIEW_AGENT_THREAD_URL` to
    // `<hookUrl>/thread`; `runReviewThreadsGet` fetches `<baseUrl>/<threadId>`.
    // Against a live HTTP server wrapping the session handler it must return
    // the draft thread instead of throwing `Comment thread not found`.
    const { reviewPath, threadUrl, sessionUrl } = await spinUpServer();
    appendReviewCommentDraft(reviewPath, {
      threadId: "thread-draft",
      messageId: "message-draft",
      target: { kind: "document" },
      body: "What does this block do?",
      author: "Reviewer",
    });

    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    const exitCode = await runReviewThreadsGet({
      cwd: rootPath!,
      env: {
        ...process.env,
        DEV_FAST_REVIEW_AGENT_HOOK_TOKEN: REVIEW_TOKEN,
        DEV_FAST_REVIEW_AGENT_THREAD_URL: threadUrl,
      },
      threadId: "thread-draft",
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      review: path.basename(rootPath!),
      state: "draft",
      comment: {
        threadId: "thread-draft",
        target: { kind: "document" },
        messages: [
          {
            id: "message-draft",
            by: "Reviewer",
            body: "What does this block do?",
          },
        ],
      },
    });
    // The thread URL the launcher wires resolves against the live server; the
    // sessionUrl origin must match so the fetch reaches the mounted route.
    expect(threadUrl.startsWith(sessionUrl)).toBe(true);
  });
});

/** Spin up a session handler without a live socket. `handler.handle` is enough. */
async function spinUpHandler(): Promise<{
  sessionUrl: string;
  reviewPath: string;
}> {
  rootPath = await mkdtemp(path.join(tmpdir(), "review-thread-route-"));
  const reviewPath = path.join(rootPath, "review.mdx");
  await writeFile(reviewPath, "# Review\n", "utf8");
  // The host is irrelevant: Hono routes on the pathname and `handler.handle`
  // never opens a socket. Only the pathname and token header matter here.
  const sessionUrl = `http://review.test${SESSION_PATH}`;
  handler = await createReviewSessionHandler({
    ...unusedAgentServices,
    rootPath,
    toolingRoot: rootPath,
    reviewPath,
    routePath: "/",
    token: REVIEW_TOKEN,
    session: {
      rootPath,
      baseRef: "HEAD",
      appUrl: sessionUrl,
      reviewPath,
      startedAt: Date.now(),
    },
  });
  return { sessionUrl, reviewPath };
}

/**
 * Spin up a real `node:http` server so `fetch` in `runReviewThreadsGet`
 * reaches the mounted route, mirroring the live desktop. The real desktop host
 * strips the `/sessions/<id>` prefix in `dispatchToSession` before calling
 * `handler.handle`, so the session API mounts root-relative at
 * `/__progressive-review/*`. Using a path-less origin here reproduces that:
 * the launcher's thread URL resolves to a root-relative pathname the mounted
 * route and auth middleware actually match.
 */
async function spinUpServer(): Promise<{
  reviewPath: string;
  sessionUrl: string;
  threadUrl: string;
}> {
  rootPath = await mkdtemp(path.join(tmpdir(), "review-thread-route-"));
  const reviewPath = path.join(rootPath, "review.mdx");
  await writeFile(reviewPath, "# Review\n", "utf8");

  let active: ReviewSessionHandler | undefined;
  server = createServer((request, response) => {
    const current = active;
    if (!current) {
      response.statusCode = 503;
      response.end();
      return;
    }
    void getRequestListener((request) => current.handle(request))(
      request,
      response,
    ).catch((error) => {
      if (!response.headersSent) response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const sessionUrl = `http://127.0.0.1:${port}`;

  handler = await createReviewSessionHandler({
    ...unusedAgentServices,
    rootPath,
    toolingRoot: rootPath,
    reviewPath,
    routePath: "/",
    token: REVIEW_TOKEN,
    session: {
      rootPath,
      baseRef: "HEAD",
      appUrl: sessionUrl,
      reviewPath,
      startedAt: Date.now(),
    },
  });
  active = handler;

  const threadUrl = `${sessionUrl}${API_PREFIX}/native-agent-events/${LAUNCH_ID}/thread`;
  return { reviewPath, sessionUrl, threadUrl };
}
