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
  it("authors rich MDX and imported data through hash-checked API writes", async () => {
    const { client, reviewId, server } = await setupServer();
    try {
      const missing = await client.getDocumentFile(reviewId, "data.ts");
      expect(missing).toEqual({
        ok: true,
        file: { name: "data.ts", source: null, sourceHash: null },
      });
      const data = "export const title = 'Rich document';\n";
      const created = await client.writeDocumentFile(reviewId, "data.ts", {
        source: data,
        expectedSourceHash: null,
      });
      expect(await client.getDocumentFile(reviewId, "data.ts")).toEqual(
        created,
      );
      // Retrying a successful write after losing its response does not conflict.
      expect(
        await client.writeDocumentFile(reviewId, "data.ts", {
          source: data,
          expectedSourceHash: null,
        }),
      ).toEqual(created);
      const initial = await client.getDocumentFile(reviewId, "review.mdx");
      if (!initial.ok) throw new Error(initial.error);
      const source =
        'import { title } from "./data.ts";\n\n# {title}\n\n<AnchorLink anchor={anchors.example}>Evidence</AnchorLink>\n\n<CodePeek anchor={anchors.example} />\n';
      const request = { source, expectedSourceHash: initial.file.sourceHash };
      const written = await client.writeDocumentFile(
        reviewId,
        "review.mdx",
        request,
      );
      expect(written).toMatchObject({ ok: true, file: { source } });
      expect(await client.getDocument(reviewId)).toMatchObject({
        ok: true,
        snapshot: { mode: "compiled", source },
      });
      await expect(
        client.writeDocumentFile(reviewId, "review.mdx", {
          ...request,
          source: "# Stale overwrite",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      // The allowlist is enforced by the server, not just TypeScript callers.
      const unknown = await fetch(
        `${server.url}/reviews/${reviewId}/document/files/review.json`,
        { headers: { "x-review-token": "review-api-token" } },
      );
      expect(unknown.status).toBe(404);
      const unauthenticated = await fetch(
        `${server.url}/reviews/${reviewId}/document/files/review.mdx`,
      );
      expect(unauthenticated.status).toBe(401);
    } finally {
      await server.close();
    }
  });

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
        client.writeDocumentFile(reviewId, "review.mdx", {
          source: "# Bypass nodes",
          expectedSourceHash: replaced.ok ? replaced.snapshot.sourceHash : null,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

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
      const created = await client.command(reviewId, {
        command: "comment.create",
        mutationId: "comment-1",
        input: {
          threadId: "thread-1",
          messageId: "message-1",
          target: { kind: "document" },
          body: "Please clarify.",
        },
      });
      const replied = await client.reply({
        reviewId,
        threadId: "thread-1",
        mutationId: "reply-1",
        messageId: "message-2",
        body: "Clarified.",
      });
      const resolved = await client.command(reviewId, {
        command: "comment.update",
        mutationId: "resolve-1",
        threadId: "thread-1",
        update: { status: "resolved" },
      });

      const comments = await client.getComments(reviewId);
      expect(created).toMatchObject({ ok: true, commit: { revision: 1 } });
      expect(replied).toMatchObject({ ok: true, commit: { revision: 2 } });
      expect(resolved).toMatchObject({ ok: true, commit: { revision: 3 } });
      expect(comments).toMatchObject({
        ok: true,
        snapshot: {
          revision: 3,
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
