import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  type HostCommandInputs,
  type HostCommandName,
  type HostQueryInputs,
  type HostQueryName,
  type JsonValue,
  ReviewRecordSchema,
  ReviewTutorialOpenResponseSchema,
  hostCommandResponseSchema,
  hostQueryResponseSchema,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "./desktop-server";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const token = "json-default-native-test-token";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
  }
});

function preservedFiles(directory: string) {
  const result: Record<
    string,
    { sha256: string; mode: number; modifiedAt: number }
  > = {};
  const visit = (relative: string) => {
    const absolute = path.join(directory, relative);
    const info = statSync(absolute);
    if (info.isDirectory())
      for (const child of readdirSync(absolute))
        visit(path.join(relative, child));
    else
      result[relative] = {
        sha256: createHash("sha256")
          .update(readFileSync(absolute))
          .digest("hex"),
        mode: info.mode,
        modifiedAt: info.mtimeMs,
      };
  };
  visit("");
  return result;
}

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "review-json-default-"));
  vi.stubEnv("DEV_REVIEW_HOME", home);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
  const repository = path.join(home, "source");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    path.join(repository, "source.ts"),
    "export const retained = true;\n",
  );
  git("add", ".");
  git("commit", "-m", "Immutable source");
  const commit = git("rev-parse", "HEAD");
  const oldId = randomUUID();
  const reviewsRoot = path.join(home, "reviews");
  const oldDirectory = path.join(reviewsRoot, oldId);
  mkdirSync(oldDirectory, { recursive: true });
  const oldRecord = ReviewRecordSchema.parse({
    schemaVersion: 4,
    uuid: oldId,
    repoKey: "old-local-repository",
    worktreePath: repository,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
    title: "Old review: keep every byte",
    sourceSession: "disabled:review",
    status: "awaiting-review",
    presentedDocumentRevision: commit,
    presentedSoftwareMapRevision: null,
    createdAt: "2020-01-01T00:00:00Z",
    lastPublishedAt: "2020-01-02T00:00:00Z",
    dismissedAt: "2020-01-03T00:00:00Z",
  });
  writeFileSync(
    path.join(oldDirectory, "review.json"),
    JSON.stringify(oldRecord),
  );
  writeFileSync(
    path.join(oldDirectory, "review.mdx"),
    "# Kept old document\n\nNever compile or replace this.\n",
  );
  writeFileSync(
    path.join(oldDirectory, "data.ts"),
    "export const original = 'preserve';\n",
  );
  const oldThreadDb = new DatabaseSync(path.join(oldDirectory, "review.db"));
  oldThreadDb.exec(
    "CREATE TABLE preserved_comments(body TEXT); INSERT INTO preserved_comments VALUES ('A saved old comment');",
  );
  oldThreadDb.close();
  const invalidId = randomUUID();
  mkdirSync(path.join(reviewsRoot, invalidId));
  writeFileSync(
    path.join(reviewsRoot, invalidId, "review.json"),
    "not parseable: old data is inactive",
  );
  const oldTutorialRoot = path.join(home, "tutorial");
  mkdirSync(path.join(oldTutorialRoot, "sample-service"), { recursive: true });
  writeFileSync(
    path.join(oldTutorialRoot, "sample-service", "preserved.txt"),
    "Previous tutorial state must not be migrated or deleted.",
  );
  const oldSystemId = randomUUID();
  mkdirSync(path.join(reviewsRoot, oldSystemId));
  writeFileSync(
    path.join(reviewsRoot, oldSystemId, "review.json"),
    JSON.stringify({
      ...oldRecord,
      uuid: oldSystemId,
      visibility: "system",
      worktreePath: path.join(oldTutorialRoot, "sample-service"),
    }),
  );
  const oldSharedPath = path.join(home, "review.db");
  const oldShared = new DatabaseSync(oldSharedPath);
  oldShared.exec(
    "CREATE TABLE old_reviews(id TEXT, comment TEXT); INSERT INTO old_reviews VALUES ('old-review', 'Do not migrate');",
  );
  oldShared.close();
  writeFileSync(
    path.join(home, "preferences.json"),
    JSON.stringify({ dismissedRetentionDays: 1 }),
  );
  const oldContents = preservedFiles(reviewsRoot);
  const oldTutorialContents = preservedFiles(oldTutorialRoot);
  const sharedContents = readFileSync(oldSharedPath);
  const sharedInfo = statSync(oldSharedPath);
  const handlers: ReviewSessionHandlerInput[] = [];
  const handle = vi.fn<ReviewSessionHandler["handle"]>(async () =>
    Response.json({ trustedTutorial: true }),
  );
  const closeHandler = vi.fn<ReviewSessionHandler["close"]>(async () => {});
  const tutorialAuthor = vi.fn<
    NonNullable<
      Parameters<
        typeof createGlobalReviewServer
      >[0]["tutorialAuthoringSessionFactory"]
    >
  >(async () => ({
    harness: "codex" as const,
    sessionId: "trusted-tutorial-source",
  }));
  const servers: ReturnType<typeof createGlobalReviewServer>[] = [];
  const start = async () => {
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      jsonHost: {
        databasePath: path.join(home, "review-host.db"),
        discoveryPath: path.join(home, "host.json"),
      },
      tutorialAgentResolver: async () => "codex",
      tutorialAuthoringSessionFactory: tutorialAuthor,
      sessionHandlerFactory: async (input) => {
        handlers.push(input);
        return {
          token,
          handle,
          close: closeHandler,
          findAgentThread: () => undefined,
        };
      },
    });
    servers.push(server);
    await server.listen();
    return server;
  };
  cleanup.push(async () => {
    for (const server of servers) await server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const unchanged = () => {
    expect(preservedFiles(oldTutorialRoot)).toEqual(oldTutorialContents);
    for (const [relative, original] of Object.entries(oldContents)) {
      const filename = path.join(reviewsRoot, relative);
      const info = statSync(filename);
      expect({
        sha256: createHash("sha256")
          .update(readFileSync(filename))
          .digest("hex"),
        mode: info.mode,
        modifiedAt: info.mtimeMs,
      }).toEqual(original);
    }
    expect(preservedFiles(oldDirectory)).toEqual(
      Object.fromEntries(
        Object.entries(oldContents)
          .filter(([name]) => name.startsWith(`${oldId}${path.sep}`))
          .map(([name, value]) => [name.slice(oldId.length + 1), value]),
      ),
    );
    expect(readFileSync(oldSharedPath)).toEqual(sharedContents);
    expect(statSync(oldSharedPath).mtimeMs).toBe(sharedInfo.mtimeMs);
    expect(statSync(oldSharedPath).mode).toBe(sharedInfo.mode);
    expect(existsSync(`${oldSharedPath}-wal`)).toBe(false);
  };
  return {
    home,
    repository,
    oldId,
    oldDirectory,
    reviewsRoot,
    start,
    unchanged,
    handlers,
    handle,
    closeHandler,
    tutorialAuthor,
  };
}

function request(
  server: ReturnType<typeof createGlobalReviewServer>,
  route: string,
  method = "GET",
  body?: JsonValue,
) {
  return fetch(`${server.url}${route}`, {
    method,
    headers: { "x-review-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function hostClient(server: ReturnType<typeof createGlobalReviewServer>) {
  const connection = await (await request(server, "/v1/connection")).json();
  const envelope = {
    apiVersion: 1,
    hostId: String(connection.hostId),
    workspaceId: String(connection.workspaceId),
    clientId: randomUUID(),
  };
  return {
    async command<K extends HostCommandName>(
      type: K,
      input: HostCommandInputs[K],
    ) {
      const response = await request(
        server,
        `/v1/workspaces/${envelope.workspaceId}/commands`,
        "POST",
        { ...envelope, commandId: randomUUID(), type, input },
      );
      const parsed = hostCommandResponseSchema(type).parse(
        await response.json(),
      );
      if (!parsed.ok)
        throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      return parsed.data.result;
    },
    async query<K extends HostQueryName>(type: K, input: HostQueryInputs[K]) {
      const response = await request(
        server,
        `/v1/workspaces/${envelope.workspaceId}/queries`,
        "POST",
        { ...envelope, type, input },
      );
      const parsed = hostQueryResponseSchema(type).parse(await response.json());
      if (!parsed.ok)
        throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      return parsed.data.result;
    },
  };
}

describe("JSON Desktop profile keeps old reviews inactive", () => {
  it("starts, lists, changes retention, and restarts without scanning or reaping old reviews", async () => {
    const f = fixture();
    const reads = vi.spyOn(filesystem, "readdir");
    syncBuiltinESMExports();
    const server = await f.start();
    expect((await request(server, "/health")).status).toBe(200);
    expect(await (await request(server, "/reviews")).json()).toEqual({
      reviews: [],
      errors: [],
    });
    expect(
      (
        await request(server, "/preferences", "PUT", {
          dismissedRetentionDays: 1,
        })
      ).status,
    ).toBe(200);
    expect(await (await request(server, "/reviews?limit=100")).json()).toEqual({
      reviews: [],
      errors: [],
    });
    await server.close();
    f.unchanged();
    const restarted = await f.start();
    expect(await (await request(restarted, "/reviews")).json()).toEqual({
      reviews: [],
      errors: [],
    });
    await restarted.close();
    expect(
      reads.mock.calls.some(([filename]) => String(filename) === f.reviewsRoot),
    ).toBe(false);
    expect(f.handlers).toEqual([]);
    f.unchanged();
  });

  it("refuses legacy open, metadata, publish, and session routes before dispatching", async () => {
    const f = fixture();
    const reads = vi.spyOn(filesystem, "readdir");
    syncBuiltinESMExports();
    const server = await f.start();
    const routes: Array<[string, string]> = [
      ["/info", "POST"],
      ["/publish-ready", "POST"],
      ["/map-publish-ready", "POST"],
      [`/reviews/${f.oldId}/open`, "POST"],
      [`/reviews/${f.oldId}/dismiss`, "POST"],
      [`/reviews/${f.oldId}/restore`, "POST"],
      [`/reviews/${f.oldId}`, "DELETE"],
      [`/sessions/${f.oldId}`, "GET"],
      [`/sessions/${f.oldId}/verb`, "POST"],
      [`/sessions/${f.oldId}/__progressive-review/comments`, "POST"],
      [`/sessions/${f.oldId}`, "DELETE"],
    ];
    for (const [route, method] of routes) {
      const response = await request(
        server,
        route,
        method,
        method === "GET" ? undefined : {},
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "legacy_review_inactive",
      });
    }
    expect(
      (await fetch(`${server.url}/reviews/${f.oldId}/open`, { method: "POST" }))
        .status,
    ).toBe(401);
    expect(await (await request(server, "/sessions")).json()).toEqual({
      items: [],
    });
    expect(f.handlers).toEqual([]);
    expect(f.handle).not.toHaveBeenCalled();
    expect(
      reads.mock.calls.some(([filename]) => String(filename) === f.reviewsRoot),
    ).toBe(false);
    await server.close();
    f.unchanged();
  });

  it("creates new API reviews in their own database and never exposes old IDs", async () => {
    const f = fixture();
    const server = await f.start();
    const client = await hostClient(server);
    const repository = await client.command("repository.register", {
      path: f.repository,
    });
    if (!("id" in repository)) throw new Error("Expected repository result");
    const created = await client.command("review.create", {
      repositoryId: repository.id,
      title: "New host review",
      change: { kind: "snapshot", ref: "HEAD" },
    });
    if (!("review" in created)) throw new Error("Expected review result");
    expect(existsSync(path.join(f.home, "review-host.db"))).toBe(true);
    expect(existsSync(path.join(f.reviewsRoot, created.review.id))).toBe(false);
    const listed = await client.query("reviews.list", {});
    expect(listed).toMatchObject({
      items: [{ id: created.review.id, title: "New host review" }],
    });
    await expect(
      client.query("review.get", { reviewId: f.oldId }),
    ).rejects.toThrow("NOT_FOUND");
    await client.command("document.mutate", {
      reviewId: created.review.id,
      expectedDocumentVersion: 0,
      operations: [
        {
          op: "node.insert",
          node: {
            id: "hello",
            type: "markdown",
            markdown: "Authored through the host.",
          },
          placement: { parentId: null, afterId: null },
        },
      ],
    });
    expect(
      await client.query("document.get", {
        reviewId: created.review.id,
        version: 1,
      }),
    ).toMatchObject({ version: 1, roots: ["hello"] });
    expect(f.handlers).toEqual([]);
    await server.close();
    f.unchanged();
  });

  it("clears obsolete canvas diagnostics on restart without changing accepted documents", async () => {
    const f = fixture();
    const server = await f.start();
    const client = await hostClient(server);
    const repository = await client.command("repository.register", {
      path: f.repository,
    });
    if (!("id" in repository)) throw new Error("Expected repository result");
    const created = await client.command("review.create", {
      repositoryId: repository.id,
      title: "Restart",
      change: { kind: "snapshot", ref: "HEAD" },
    });
    if (!("review" in created)) throw new Error("Expected review result");
    await client.command("canvas.report", {
      reviewId: created.review.id,
      canvasSessionId: randomUUID(),
      documentVersion: 0,
      status: "rendered",
      visibleNodeIds: [],
      failures: [],
    });
    expect(
      await client.query("canvas.reports", { reviewId: created.review.id }),
    ).toHaveLength(1);
    const original = await client.query("document.get", {
      reviewId: created.review.id,
      version: 0,
    });
    await server.close();
    const restarted = await f.start();
    const after = await hostClient(restarted);
    expect(
      await after.query("canvas.reports", { reviewId: created.review.id }),
    ).toEqual([]);
    expect(
      await after.query("document.get", {
        reviewId: created.review.id,
        version: 0,
      }),
    ).toEqual(original);
    await restarted.close();
    f.unchanged();
  });

  it("keeps the trusted tutorial preparation, session routes, and deletion available", async () => {
    const f = fixture();
    const reads = vi.spyOn(filesystem, "readdir");
    syncBuiltinESMExports();
    const server = await f.start();
    expect((await request(server, "/tutorial/status")).status).toBe(200);
    expect((await request(server, "/tutorial/prepare", "POST")).status).toBe(
      200,
    );
    expect(f.tutorialAuthor).not.toHaveBeenCalled();
    const response = await request(server, "/tutorial/open", "POST");
    expect(response.status).toBe(200);
    const opened = ReviewTutorialOpenResponseSchema.parse(
      await response.json(),
    );
    expect(f.handlers).toHaveLength(1);
    expect(f.handlers[0]?.stateReviewPath).toContain(
      path.join("review-host-tutorial", "reviews", opened.reviewUuid),
    );
    expect(existsSync(path.join(f.reviewsRoot, opened.reviewUuid))).toBe(false);
    await vi.waitFor(() => expect(f.tutorialAuthor).toHaveBeenCalledOnce());
    const tutorialRead = await request(
      server,
      `/sessions/${opened.sessionId}/__progressive-review/session`,
    );
    expect(tutorialRead.status).toBe(200);
    expect(await tutorialRead.json()).toEqual({ trustedTutorial: true });
    const removed = await request(
      server,
      `/reviews/${opened.reviewUuid}`,
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(f.closeHandler).toHaveBeenCalledOnce();
    expect(
      (
        await request(
          server,
          `/sessions/${opened.sessionId}/__progressive-review/session`,
        )
      ).status,
    ).toBe(410);
    expect(await (await request(server, "/reviews")).json()).toEqual({
      reviews: [],
      errors: [],
    });
    await server.close();
    expect(
      reads.mock.calls.some(([filename]) => String(filename) === f.reviewsRoot),
    ).toBe(false);
    f.unchanged();
  });
});
