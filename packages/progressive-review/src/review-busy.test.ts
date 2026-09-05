import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { createReviewDir, readStoredReview } from "./review-home";
import {
  ReviewBusyError,
  withReviewMutationLock,
} from "./review-mutation-lock";
import { runReviewPublish } from "./review-publish";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { createGlobalReviewServer } from "./server/desktop-server";
import { createReviewSessionHandler } from "./server/session-handler";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reports loader, open, and CLI contention as busy and allows migration after release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-busy-read-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  await writeFile(
    path.join(home, "preferences.json"),
    JSON.stringify({ dismissedRetentionDays: null }),
  );
  const root = path.join(home, "source");
  await mkdir(root);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const review = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: sourceCommit,
    sourceCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const recordPath = path.join(review.dir, "review.json");
  const recordBytes = JSON.stringify({ ...review.review, schemaVersion: 4 });
  await writeFile(recordPath, recordBytes);
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    token: "busy-token",
    port: 0,
    discoveryPath: path.join(home, "desktop.json"),
  });
  const entered = deferred();
  const release = deferred();
  const holding = withReviewMutationLock(review.dir, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    await server.listen();
    const [loaded, response, exitCode, ...readyResponses] = await Promise.all([
      readStoredReview(review.dir),
      fetch(`${server.url}/reviews/${review.review.uuid}/open`, {
        method: "POST",
        headers: {
          "x-review-token": "busy-token",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      runReviewPublish({
        cwd: root,
        reviewUuid: review.review.uuid,
        json: true,
        stdout,
      }),
      ...["publish-ready", "map-publish-ready", "repair-ready"].map((route) =>
        fetch(`${server.url}/${route}`, {
          method: "POST",
          headers: {
            "x-review-token": "busy-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(
            route === "repair-ready"
              ? {
                  reviewUuid: review.review.uuid,
                  stagingDir: root,
                  expectedRecord: recordBytes,
                  expectedFingerprint: "a".repeat(64),
                  newDocumentRevision: "a".repeat(40),
                  newMapRevision: null,
                  sourceFallback: { document: false, map: false },
                }
              : { reviewUuid: review.review.uuid, revision: "a".repeat(40) },
          ),
        }),
      ),
    ]);
    expect(loaded).toMatchObject({
      error: {
        code: "REVIEW_BUSY",
        message: expect.stringContaining(
          "Retry after its current operation completes",
        ),
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "review_busy",
      retryable: true,
    });
    for (const readyResponse of readyResponses) {
      expect(readyResponse.status).toBe(409);
      expect(await readyResponse.json()).toMatchObject({
        ok: false,
        code: "review_busy",
        retryable: true,
      });
    }
    expect(exitCode).toBe(1);
    expect(output).toContain("Retry after its current operation completes");
    expect(output).not.toContain("review repair");
    expect(await readFile(recordPath, "utf8")).toBe(recordBytes);
  } finally {
    release.resolve();
    await holding;
    await server.close();
  }
  expect(await readStoredReview(review.dir)).toMatchObject({
    review: { schemaVersion: 5 },
  });
}, 20_000);

it.each(["thread-commands", "revisions"])(
  "returns a retryable HTTP conflict for busy %s requests",
  async (route) => {
    const root = await mkdtemp(path.join(tmpdir(), "review-busy-session-"));
    roots.push(root);
    const reviewPath = path.join(root, "review.mdx");
    await writeFile(reviewPath, "# Review\n");
    const handler = await createReviewSessionHandler({
      rootPath: root,
      reviewPath,
      toolingRoot: root,
      routePath: "/",
      token: "busy-token",
      session: {
        rootPath: root,
        reviewPath,
        baseRef: "HEAD",
        appUrl: "http://127.0.0.1:5570",
        startedAt: Date.now(),
      },
      agentServer: () => {
        throw new Error("No native agent in this test");
      },
      openNativeAgentTerminal: async () => {
        throw new Error("No terminal in this test");
      },
      runReviewThreadMutation: async () => {
        throw new ReviewBusyError(root);
      },
      listDocumentVersions: async () => {
        throw new ReviewBusyError(root);
      },
    });
    try {
      const response = await handler.handle(
        new Request(`http://127.0.0.1:5570/__progressive-review/${route}`, {
          method: route === "thread-commands" ? "POST" : "GET",
          headers: {
            "x-review-token": "busy-token",
            "content-type": "application/json",
          },
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "review_busy",
        retryable: true,
        error: expect.stringContaining(
          "Retry after its current operation completes",
        ),
      });
    } finally {
      await handler.close();
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
