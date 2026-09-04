import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ReviewRecordSchema } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewCanvasApiClient } from "../review-canvas-api-client";
import {
  closeAllReviewStateDatabases,
  putReviewRecord,
} from "../review-state-db";
import { createGlobalReviewServer } from "./desktop-server";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const roots: string[] = [];

afterEach(async () => {
  closeAllReviewStateDatabases();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Review Desktop document and comment API", () => {
  it("updates the MDX document incrementally and rejects stale revisions", async () => {
    const { client, reviewId, server } = await setupServer();
    try {
      const initial = await client.getDocument(reviewId);
      expect(initial).toMatchObject({
        ok: true,
        snapshot: { mode: "compiled", revision: 0 },
      });
      if (!initial.ok) throw new Error(initial.error);

      const replaced = await client.mutateDocument(reviewId, {
        mutationId: "replace-1",
        expectedRevision: 0,
        expectedSourceHash: initial.snapshot.sourceHash,
        operation: {
          type: "replace",
          nodes: [{ id: "intro", kind: "markdown", content: "# Hello" }],
        },
      });
      expect(replaced).toMatchObject({
        ok: true,
        snapshot: { revision: 1, nodes: [{ id: "intro" }] },
      });

      await expect(
        client.getDocumentNode(reviewId, "intro"),
      ).resolves.toMatchObject({
        ok: true,
        revision: 1,
        node: { id: "intro", content: "# Hello" },
      });
      await expect(
        client.getDocumentNode(reviewId, "missing"),
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        client.mutateDocument(reviewId, {
          mutationId: "stale-1",
          expectedRevision: 0,
          operation: { type: "delete", nodeId: "intro" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await server.close();
    }
  });

  it("exposes comment reads and mutations without client database access", async () => {
    const { client, reviewId, server } = await setupServer();
    try {
      await client.command(reviewId, {
        command: "comment.create",
        mutationId: "comment-1",
        input: {
          threadId: "thread-1",
          messageId: "message-1",
          target: { kind: "document" },
          body: "Please clarify.",
        },
      });
      await client.reply({
        reviewId,
        threadId: "thread-1",
        mutationId: "reply-1",
        messageId: "message-2",
        body: "Clarified.",
      });
      await client.command(reviewId, {
        command: "comment.update",
        mutationId: "resolve-1",
        threadId: "thread-1",
        update: { status: "resolved" },
      });

      const comments = await client.getComments(reviewId);
      expect(comments).toMatchObject({
        ok: true,
        snapshot: {
          comments: {
            "thread-1": {
              status: "resolved",
              messages: [
                { body: "Please clarify." },
                { body: "Clarified.", role: "agent" },
              ],
            },
          },
        },
      });
    } finally {
      await server.close();
    }
  });
});

async function setupServer() {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-api-server-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const reviewId = "11111111-1111-4111-8111-111111111111";
  const reviewDir = path.join(home, "reviews", reviewId);
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(reviewDir, "review.mdx"), "# Existing\n", "utf8");
  putReviewRecord(
    reviewDir,
    ReviewRecordSchema.parse({
      schemaVersion: 4,
      uuid: reviewId,
      repoKey: "repo",
      worktreePath: home,
      baseRef: "main",
      baseCommit: "a".repeat(40),
      sourceCommit: "b".repeat(40),
      sourceIdentity: { kind: "git-branch", name: "main" },
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "API Review",
      sourceSession: "disabled:review",
      status: "draft",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
    }),
  );
  const token = "review-api-token";
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
  });
  await server.listen();
  const client = new ReviewCanvasApiClient({
    discovery: {
      version: 3,
      instanceId: server.discovery.instanceId,
      url: server.url,
      appPid: process.pid,
      serverPid: process.pid,
      token,
      startedAt: Date.now(),
    },
  });
  return { client, reviewId, server };
}
