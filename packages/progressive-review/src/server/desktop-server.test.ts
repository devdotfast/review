import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeNote } from "@dev.fast/local-vcs";
import { type JsonObject, jsonObject } from "@dev.fast/review-protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  readLegacyReviewGolden,
} from "../fixtures/legacy-reviews/legacy-review-fixture";
import { readReviewSoftwareMapArtifact } from "../review-artifact-store";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { reviewDocumentDataSchema } from "../review-document-data";
import {
  createReviewDir,
  parseStoredReviewRecord,
  reviewTitleFromDocument,
} from "../review-home";
import { parsePublicationRecord } from "../review-publication-record";
import {
  listPublications,
  putReviewRecord,
  readPublication,
  readReviewRecord,
} from "../review-state-db";
import { appendReviewComment } from "../review-state-store";
import { SOFTWARE_MAP_NOTES_REF } from "../review-storage";
import { cleanupTempDirs } from "../review-test-utils";
import {
  closeAllReviewThreadStores,
  createLegacyReviewThreadDb,
} from "../review-thread-store-backend";
import { reviewVcs } from "../review-vcs";
import {
  type ReviewAgentSessionSource,
  createGlobalReviewServer,
  reviewAgentKind,
} from "./desktop-server";
import {
  type ReviewPublicationResult,
  publicationHarness,
  softwareMapNote,
} from "./publication-test-utils";

let directory: string | undefined;
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("reviewTitleFromDocument", () => {
  it("uses the first ATX H1 after frontmatter and strips closing markdown", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-title-"));
    const documentPath = path.join(directory, "review.mdx");
    await writeFile(
      documentPath,
      "---\ntitle: ignored\n---\n# Tab identity smoke ###\n# Later heading\n",
    );

    await expect(reviewTitleFromDocument(documentPath)).resolves.toBe(
      "Tab identity smoke",
    );
  });

  it("keeps the stored title when the document has no ATX H1", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-title-"));
    const documentPath = path.join(directory, "review.mdx");
    await writeFile(documentPath, "---\ntitle: ignored\n---\n## Not an H1\n");

    await expect(
      reviewTitleFromDocument(documentPath),
    ).resolves.toBeUndefined();
  });
});

describe("reviewAgentKind", () => {
  it("uses the latest publisher, then author, then legacy creator", () => {
    const review: ReviewAgentSessionSource = {
      sourceSession: "pi:legacy",
      agentSessions: {
        "codex:author": {
          roles: ["author"],
          firstSeenAt: "2026-08-12T09:00:00.000Z",
          lastSeenAt: "2026-08-12T09:00:00.000Z",
        },
        "claude-code:publisher": {
          roles: ["publisher"],
          firstSeenAt: "2026-08-12T10:00:00.000Z",
          lastSeenAt: "2026-08-12T10:00:00.000Z",
        },
      },
    };
    expect(reviewAgentKind(review)).toBe("claude");
    expect(
      reviewAgentKind({
        ...review,
        agentSessions: {
          "codex:author": review.agentSessions!["codex:author"]!,
        },
      }),
    ).toBe("codex");
    expect(reviewAgentKind({ ...review, agentSessions: undefined })).toBe("pi");
    expect(
      reviewAgentKind({
        ...review,
        sourceSession: "fresh:pi",
        agentSessions: undefined,
      }),
    ).toBe("pi");
  });
});

describe("Review Desktop open requests", () => {
  it("migrates a legacy review on direct open and keeps historical JSON readable", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-recovery-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", directory);
    await writeFile(
      path.join(directory, "preferences.json"),
      JSON.stringify({ dismissedRetentionDays: null }),
    );
    const uuid = "11111111-1111-4111-8111-111111111111";
    const dir = path.join(directory, "reviews", uuid);
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    const source = await makeSourceRepository(directory);
    const record = {
      schemaVersion: 4,
      uuid,
      repoKey: "repo",
      worktreePath: source.root,
      baseRef: "main",
      baseCommit: source.commit,
      sourceCommit: source.commit,
      sourceIdentity: null,
      title: "Recovery",
      sourceSession: "disabled:review",
      status: "accepted",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-09-01T00:00:00Z",
      lastPublishedAt: "2026-09-01T00:00:00Z",
      dismissedAt: "2026-01-01T00:00:00Z",
    };
    await writeFile(path.join(dir, "review.mdx"), "# Recovery");
    await writeFile(path.join(dir, ".gitignore"), ".build/\nreview.db*\n");
    await writeFile(path.join(dir, "review.json"), JSON.stringify(record));
    const oldRevision = await reviewVcs.seal(dir, "Review publish candidate");
    await writeReviewDocumentBundle(
      dir,
      bundleReviewDocument({
        format: "review-document/1",
        title: "Recovery",
        routePath: "/",
        sourcePath: "review.mdx",
        body: [],
        anchors: {},
        anchorContents: {},
        softwareModels: [],
      }),
    );
    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify({ ...record, sourceCommit: "f".repeat(40) }),
    );
    const historicalJsonRevision = await reviewVcs.seal(
      dir,
      "Review publish candidate",
    );
    await writeFile(path.join(dir, "review.json"), JSON.stringify(record));
    await writeFile(
      path.join(dir, "review.mdx"),
      "# Recovery\n\nCurrent revision",
    );
    await rm(path.join(dir, ".bundle/document"), {
      recursive: true,
      force: true,
    });
    await mkdir(path.join(dir, ".bundle/document"), { recursive: true });
    await writeFile(
      path.join(dir, ".bundle/document/manifest.json"),
      JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
    );
    await writeFile(
      path.join(dir, ".bundle/document/review-document.js"),
      `import { createActiveReviewDocument, jsx } from "review-doc-runtime";
export default createActiveReviewDocument({ title: "Legacy", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Legacy sealed" }), isDefault: true });`,
    );
    const currentRevision = await reviewVcs.seal(
      dir,
      "Review publish candidate",
    );
    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify({ ...record, presentedDocumentRevision: currentRevision }),
    );
    createLegacyReviewThreadDb(dir);
    appendReviewComment(path.join(dir, "review.mdx"), {
      threadId: "recovery-thread",
      messageId: "recovery-message",
      target: { kind: "document" },
      body: "Keep this thread",
      author: "Reviewer",
    });
    closeAllReviewThreadStores();
    const files = [
      "review.json",
      "review.mdx",
      "review.db",
      ".git/refs/heads/main",
    ];
    const before = await Promise.all(
      files.map((file) => readFile(path.join(dir, file))),
    );
    const token = "recovery-secret";
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(directory, "desktop.json"),
    });
    try {
      await server.listen();
      const request = (route: string, body?: JsonObject) =>
        fetch(`${server.url}${route}`, {
          method: body ? "POST" : "GET",
          headers: {
            "x-review-token": token,
            "content-type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const current = await request(`/reviews/${uuid}/open`, {});
      expect(current.status).toBe(201);
      const opened = await current.json();
      expect(opened.review).not.toHaveProperty("recovery");
      const migrated = JSON.parse(
        await readFile(path.join(dir, "review.json"), "utf8"),
      );
      expect(migrated).toMatchObject({
        schemaVersion: 5,
        status: "accepted",
        dismissedAt: null,
      });
      expect(migrated.presentedDocumentRevision).not.toBe(currentRevision);
      const listed = await (await request("/reviews")).json();
      expect(listed.errors).toEqual([]);
      expect(listed.reviews).toHaveLength(1);
      expect(listed.reviews[0]).toMatchObject({
        status: "accepted",
        available: true,
      });
      expect(listed.reviews[0]).not.toHaveProperty("recovery");
      const prefix = `/sessions/${opened.sessionId}/__progressive-review`;
      expect((await request(`${prefix}/document`)).status).toBe(200);
      const comments = await request(`${prefix}/comments`);
      expect(comments.status).toBe(200);
      expect(
        (await comments.json()).snapshot.comments["recovery-thread"].messages,
      ).toHaveLength(1);
      const historical = await request(`/reviews/${uuid}/open`, {
        revision: oldRevision,
      });
      expect(historical.status).toBe(201);
      const old = await historical.json();
      expect(
        await (
          await request(
            `/sessions/${old.sessionId}/__progressive-review/document`,
          )
        ).json(),
      ).toMatchObject({
        error: "This older revision is unavailable in this version of Review",
        detail: { code: "historical_revision_unavailable", reviewUuid: uuid },
      });
      const historicalJson = await request(`/reviews/${uuid}/open`, {
        revision: historicalJsonRevision,
      });
      expect(historicalJson.status).toBe(201);
      const jsonVersion = await historicalJson.json();
      expect(jsonVersion.session.historicalRevision).toBe(
        historicalJsonRevision,
      );
      expect(jsonVersion.session.sourceUnavailable).toContain(
        "The pinned source commits are unavailable:",
      );
      expect(jsonVersion.review.sourceUnavailable).toBeUndefined();
      const refreshedSessions = await (await request("/sessions")).json();
      expect(
        refreshedSessions.items.find(
          (item: { sessionId: string }) =>
            item.sessionId === jsonVersion.sessionId,
        ),
      ).toMatchObject(jsonVersion.session);
      expect(
        refreshedSessions.items.find(
          (item: { sessionId: string }) => item.sessionId === opened.sessionId,
        ).sourceUnavailable,
      ).toBeUndefined();
      const refreshedReviews = await (await request("/reviews")).json();
      expect(refreshedReviews.reviews[0].sourceUnavailable).toBeUndefined();
      const reopened = await (
        await request(`/reviews/${uuid}/open`, {
          revision: historicalJsonRevision,
        })
      ).json();
      expect(reopened.session).toEqual(jsonVersion.session);
      const unavailableDiff = await request(
        `/sessions/${jsonVersion.sessionId}/__progressive-review/diff-files`,
        {},
      );
      expect(unavailableDiff.status).toBe(400);
      expect((await unavailableDiff.json()).error).toBe(
        jsonVersion.session.sourceUnavailable,
      );
      expect((await request(`${prefix}/diff-files`, {})).status).toBe(200);
      expect(
        (
          await request(
            `/sessions/${jsonVersion.sessionId}/__progressive-review/document`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            `/sessions/${jsonVersion.sessionId}/__progressive-review/dismiss`,
            {},
          )
        ).status,
      ).toBe(409);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });
  it("refuses to open corrupt sealed artifacts without changing records or refs", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-recovery-server-"));
    vi.stubEnv("DEV_REVIEW_HOME", directory);
    await writeFile(
      path.join(directory, "preferences.json"),
      JSON.stringify({ dismissedRetentionDays: null }),
    );
    const uuid = "11111111-1111-4111-8111-111111111111";
    const dir = path.join(directory, "reviews", uuid);
    await mkdir(dir, { recursive: true });
    await reviewVcs.init(dir);
    const source = await makeSourceRepository(directory);
    const record = {
      schemaVersion: 4,
      uuid,
      repoKey: "repo",
      worktreePath: source.root,
      baseRef: "main",
      baseCommit: source.commit,
      sourceCommit: source.commit,
      sourceIdentity: null,
      title: "Recovery",
      sourceSession: "disabled:review",
      status: "accepted",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-09-01T00:00:00Z",
      lastPublishedAt: "2026-09-01T00:00:00Z",
      dismissedAt: "2026-01-01T00:00:00Z",
    };
    await writeFile(path.join(dir, "review.mdx"), "# Recovery");
    await writeFile(path.join(dir, ".gitignore"), ".build/\nreview.db*\n");
    await writeFile(path.join(dir, "review.json"), JSON.stringify(record));
    await reviewVcs.seal(dir, "Review publish candidate");
    await writeReviewDocumentBundle(
      dir,
      bundleReviewDocument({
        format: "review-document/1",
        title: "Recovery",
        routePath: "/",
        sourcePath: "review.mdx",
        body: [],
        anchors: {},
        anchorContents: {},
        softwareModels: [],
      }),
    );
    await reviewVcs.seal(dir, "Review publish candidate");
    await writeFile(
      path.join(dir, "review.mdx"),
      "# Recovery\n\nCurrent revision",
    );
    await rm(path.join(dir, ".bundle/document"), {
      recursive: true,
      force: true,
    });
    await mkdir(path.join(dir, ".bundle/document"), { recursive: true });
    await writeFile(
      path.join(dir, ".bundle/document/manifest.json"),
      JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
    );
    await writeFile(
      path.join(dir, ".bundle/document/review-document.js"),
      'throw new Error("corrupt sealed document");',
    );
    const currentRevision = await reviewVcs.seal(
      dir,
      "Review publish candidate",
    );
    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify({ ...record, presentedDocumentRevision: currentRevision }),
    );
    createLegacyReviewThreadDb(dir);
    appendReviewComment(path.join(dir, "review.mdx"), {
      threadId: "recovery-thread",
      messageId: "recovery-message",
      target: { kind: "document" },
      body: "Keep this thread",
      author: "Reviewer",
    });
    closeAllReviewThreadStores();
    const files = [
      "review.json",
      "review.mdx",
      "review.db",
      ".git/refs/heads/main",
    ];
    const before = await Promise.all(
      files.map((file) => readFile(path.join(dir, file))),
    );
    const token = "recovery-secret";
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(directory, "desktop.json"),
    });
    try {
      await server.listen();
      const request = (route: string, body?: JsonObject) =>
        fetch(`${server.url}${route}`, {
          method: body ? "POST" : "GET",
          headers: {
            "x-review-token": token,
            "content-type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const current = await request(`/reviews/${uuid}/open`, {});
      expect(current.status).toBe(409);
      expect(await current.json()).toMatchObject({
        ok: false,
        code: "repair_required",
        error: expect.stringContaining(`review repair --review ${uuid}`),
      });
      const listed = await (await request("/reviews")).json();
      expect(listed.reviews).toEqual([]);
      expect(listed.errors).toMatchObject([
        { code: "REPAIR_REQUIRED", reviewUuid: uuid },
      ]);
      expect(
        await Promise.all(files.map((file) => readFile(path.join(dir, file)))),
      ).toEqual(before);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });
  it("rejects an unknown Review view before opening a session", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-view-server-"));
    const token = "review-view-test-token";
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(directory, "desktop.json"),
    });

    try {
      await server.listen();
      const response = await fetch(
        `${server.url}/reviews/11111111-1111-4111-8111-111111111111/open`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-review-token": token,
          },
          body: JSON.stringify({ view: "files" }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "invalid_view",
      });
    } finally {
      await server.close();
    }
  });
});

describe("publishing a Review document as a JSON publication", () => {
  afterEach(async () => {
    closeAllReviewThreadStores();
    await cleanupTempDirs();
  });

  it("commits one publication row, moves the pointer, and seals no Git revision", async () => {
    const harness = await publicationHarness({
      document: "# Publication title\n\nFirst publication.\n",
    });
    try {
      const result = await harness.publishDocument();
      expect(result).toMatchObject({ ok: true });
      const rows = listPublications(harness.review.dir, "document");
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const record = parsePublicationRecord(row.record);
      if (record.kind !== "document")
        throw new Error("Expected a document publication");
      expect(record).toMatchObject({
        reviewUuid: harness.review.review.uuid,
        operation: "publish",
        previousPublicationId: null,
        pairedMapPublicationId: null,
        title: "Publication title",
        titleSource: "document",
        baseRef: "main",
        baseCommit: harness.sourceCommit,
        sourceCommit: harness.sourceCommit,
      });
      expect(record.artifact).toEqual({
        state: "stored",
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      if (record.artifact.state !== "stored") throw new Error("unreachable");
      expect(
        existsSync(
          path.join(
            harness.review.dir,
            "artifacts",
            "documents",
            `${record.artifact.hash}.json`,
          ),
        ),
      ).toBe(true);
      const stored = readReviewRecord(harness.review.dir);
      expect(stored).toMatchObject({
        presentedDocumentRevision: row.publicationId,
        status: "awaiting-review",
        title: "Publication title",
        viewedAt: null,
        dismissedAt: null,
      });
      expect(
        JSON.parse(
          await readFile(path.join(harness.review.dir, "review.json"), "utf8"),
        ).presentedDocumentRevision,
      ).toBe(row.publicationId);
      // Publication replaced the private Git seal outright.
      expect(await reviewVcs.log(harness.review.dir)).toEqual([]);
      expect(
        result.events.find((event) => event.event === "document-published"),
      ).toMatchObject({
        revision: row.publicationId,
        softwareMapRevision: null,
      });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("stores the artifact before the row and the row before the pointer", async () => {
    const order: string[] = [];
    let artifactsAtVerify = false;
    let pointerAtInsert: unknown;
    const harness = await publicationHarness({
      activationHooks: {
        afterArtifactVerify: () => {
          artifactsAtVerify = existsSync(
            path.join(harness.review.dir, "artifacts", "documents"),
          );
          order.push("artifact");
        },
        afterPublicationInsert: () => {
          pointerAtInsert = presentedDocumentRevision(harness.review.dir);
          order.push("row");
        },
        afterPointerUpdate: () => order.push("pointer"),
        afterCommit: () => order.push("commit"),
      },
    });
    try {
      expect(await harness.publishDocument()).toMatchObject({ ok: true });
      expect(order).toEqual(["artifact", "row", "pointer", "commit"]);
      // Invariant 3: the bytes exist before anything references them, and the
      // pointer still names the previous publication while the row is written.
      expect(artifactsAtVerify).toBe(true);
      expect(pointerAtInsert).toBeNull();
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("leaves no row when the candidate fails to mount and commits exactly one on the retry", async () => {
    const harness = await publicationHarness();
    try {
      harness.respond = async (_sessionId, verb) =>
        jsonObject(verb)?.name === "validateCanvasMount"
          ? { ok: false, error: "test mount failure" }
          : { ok: true };
      const failed = await harness.publishDocument();
      expect(failed).toMatchObject({ ok: false });
      expect(failed.events).toContainEqual({
        event: "error",
        stage: "publish",
        diagnostics: [expect.stringContaining("test mount failure")],
      });
      expect(listPublications(harness.review.dir, "document")).toEqual([]);
      expect(readReviewRecord(harness.review.dir)).toMatchObject({
        presentedDocumentRevision: null,
        status: "draft",
      });

      harness.respond = async () => ({ ok: true });
      const published = await harness.publishDocument();
      expect(published).toMatchObject({ ok: true });
      const rows = listPublications(harness.review.dir, "document");
      expect(rows).toHaveLength(1);
      const sessionId = sessionIdOf(published);
      const versions = await (
        await harness.request(
          `/sessions/${sessionId}/__progressive-review/revisions`,
        )
      ).json();
      expect(versions.versions).toEqual([
        {
          revision: rows[0]!.publicationId,
          sealedAt: Date.parse(rows[0]!.createdAt),
          isCurrent: true,
        },
      ]);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("refuses to commit a publication whose review moved during the mount", async () => {
    const harness = await publicationHarness();
    try {
      harness.respond = async (_sessionId, verb) => {
        if (jsonObject(verb)?.name === "validateCanvasMount") {
          putReviewRecord(harness.review.dir, {
            ...harness.review.review,
            baseRef: "release",
          });
        }
        return { ok: true };
      };
      const result = await harness.publishDocument();
      expect(result).toMatchObject({ ok: false });
      expect(result.events).toContainEqual({
        event: "error",
        stage: "publish",
        diagnostics: [
          expect.stringContaining("Review changed while preparing"),
        ],
      });
      expect(listPublications(harness.review.dir, "document")).toEqual([]);
      expect(readReviewRecord(harness.review.dir)).toMatchObject({
        baseRef: "release",
        presentedDocumentRevision: null,
      });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("keeps an explicit title override across a publish and its historical open", async () => {
    const harness = await publicationHarness({
      document: "# Document heading\n\nBody.\n",
    });
    try {
      expect(
        (
          await harness.request("/lifecycle/metadata", {
            reviewUuid: harness.review.review.uuid,
            expectedTitle: harness.review.review.title,
            title: "Reviewer's title",
          })
        ).status,
      ).toBe(200);
      await harness.publishDocument();
      const row = listPublications(harness.review.dir, "document")[0]!;
      const record = parsePublicationRecord(row.record);
      expect(record).toMatchObject({
        title: "Reviewer's title",
        titleSource: "override",
      });
      expect(readReviewRecord(harness.review.dir)).toMatchObject({
        title: "Reviewer's title",
        titleOverride: "Reviewer's title",
      });
      await harness.restart();
      const opened = await (
        await harness.request(`/reviews/${harness.review.review.uuid}/open`, {
          revision: row.publicationId,
        })
      ).json();
      const document = await (
        await harness.request(
          `/sessions/${opened.sessionId}/__progressive-review/document`,
        )
      ).json();
      expect(document).toMatchObject({ ok: true });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("opens current and historical publications from rows after .build and .git are gone", async () => {
    const harness = await publicationHarness({
      softwareMap: softwareMapNote("First map"),
      document: "# First\n\nOne.\n",
    });
    try {
      const first = await harness.publishDocument();
      expect(first).toMatchObject({ ok: true });
      expect(await harness.publishMap()).toMatchObject({ ok: true });
      const firstMap = listPublications(harness.review.dir, "map")[0]!;

      await writeFile(
        path.join(harness.review.dir, "review.mdx"),
        "# Second\n\nTwo.\n",
      );
      const second = await harness.publishDocument();
      expect(second).toMatchObject({ ok: true });
      const secondDocument = revisionOf(second, "document-published");

      await writeNote({
        rootPath: harness.source,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: harness.sourceCommit,
        content: softwareMapNote("Second map"),
      });
      expect(await harness.publishMap()).toMatchObject({ ok: true });
      // Newest first, so the second publication leads and the first is the
      // one the earlier document was published beside.
      const maps = listPublications(harness.review.dir, "map");
      expect(maps).toHaveLength(2);
      expect(maps[1]!.publicationId).toBe(firstMap.publicationId);

      // A later commit re-pins the Review, so the older publication is the
      // only place its own code context survives.
      const secondCommit = commitFile(harness.source, "added.ts");
      await writeNote({
        rootPath: harness.source,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: secondCommit,
        content: softwareMapNote("Second map"),
      });
      putReviewRecord(harness.review.dir, {
        ...parseStoredReviewRecord(readReviewRecord(harness.review.dir)!),
        sourceCommit: secondCommit,
      });
      await writeFile(
        path.join(harness.review.dir, "review.mdx"),
        "# Third\n\nThree.\n",
      );
      const third = await harness.publishDocument();
      expect(third).toMatchObject({ ok: true });

      await rm(path.join(harness.review.dir, ".build"), {
        recursive: true,
        force: true,
      });
      await rm(path.join(harness.review.dir, ".git"), {
        recursive: true,
        force: true,
      });
      await harness.restart();

      const current = await harness.request(
        `/reviews/${harness.review.review.uuid}/open`,
        {},
      );
      expect(current.status).toBe(201);
      const currentSession = await current.json();
      const currentPrefix = `/sessions/${currentSession.sessionId}/__progressive-review`;
      expect(
        await (await harness.request(`${currentPrefix}/document`)).json(),
      ).toMatchObject({ ok: true });
      expect(
        await (await harness.request(`${currentPrefix}/software-map`)).json(),
      ).toMatchObject({
        ok: true,
        contentHash: await mapContentHash(
          harness.review.dir,
          maps[0]!.publicationId,
        ),
      });
      const currentDiff = await (
        await harness.request(`${currentPrefix}/diff-files`, {})
      ).json();
      expect(
        currentDiff.files.map((file: { path: string }) => file.path),
      ).toEqual(["added.ts"]);

      const historical = await harness.request(
        `/reviews/${harness.review.review.uuid}/open`,
        { revision: secondDocument },
      );
      expect(historical.status).toBe(201);
      const historicalSession = await historical.json();
      expect(historicalSession.session.historicalRevision).toBe(secondDocument);
      const historicalPrefix = `/sessions/${historicalSession.sessionId}/__progressive-review`;
      // The publication carries its own code context, not the review's.
      const historicalDiff = await (
        await harness.request(`${historicalPrefix}/diff-files`, {})
      ).json();
      expect(historicalDiff.files).toEqual([]);
      // ...and the map it was published beside, not the presented one.
      const historicalMap = await (
        await harness.request(`${historicalPrefix}/software-map`)
      ).json();
      expect(historicalMap.contentHash).toBe(
        await mapContentHash(harness.review.dir, firstMap.publicationId),
      );

      expect(
        (
          await harness.request(`/reviews/${harness.review.review.uuid}/open`, {
            revision: "a".repeat(40),
          })
        ).status,
      ).toBe(404);
    } finally {
      await harness.close();
    }
  }, 120_000);
});

const legacyOpenFixtures = listLegacyReviewFixtures().filter(
  (fixture) => fixture.sourceRepository === "devdotfast/review",
);

describe("real legacy fixtures open end to end", () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

  // A shallow or partial checkout used to skip these silently, so the suite
  // reported green while testing nothing. Missing pins are now a failure.
  beforeAll(() => {
    const hasCommit = (commit: string) => {
      try {
        execFileSync(
          "git",
          ["-C", repositoryRoot, "cat-file", "-e", `${commit}^{commit}`],
          { stdio: "pipe" },
        );
        return true;
      } catch {
        return false;
      }
    };
    const missing = legacyOpenFixtures.flatMap((fixture) =>
      [fixture.baseCommit, fixture.sourceCommit]
        .filter((commit) => !hasCommit(commit))
        .map((commit) => `${fixture.name} ${commit}`),
    );
    if (missing.length > 0)
      throw new Error(
        `Legacy fixture commits are missing from ${repositoryRoot}. Run \`git fetch --unshallow origin\` (or \`git fetch origin\`) and retry: ${missing.join(", ")}`,
      );
  });

  for (const fixture of legacyOpenFixtures) {
    it(`opens ${fixture.name} as a current review`, async () => {
      const { home, uuid, originalRecord } = await extractLegacyReviewFixture(
        fixture.name,
      );
      directory = home;
      const sourcePath = String(originalRecord.worktreePath);
      // Only the two pinned commits are needed. Cloning the monorepo copied
      // ~100MB of unrelated history per fixture; fetching the exact commits
      // into an empty repository copies ~23MB and still resolves their
      // merge base. `--filter=blob:none` is not used: git's local transport
      // ignores it and warns.
      execFileSync("git", ["init", "--quiet", "-b", "main", sourcePath], {
        stdio: "pipe",
      });
      execFileSync(
        "git",
        [
          "-C",
          sourcePath,
          "fetch",
          "--quiet",
          "--no-tags",
          repositoryRoot,
          fixture.baseCommit,
          fixture.sourceCommit,
        ],
        { stdio: "pipe" },
      );
      vi.stubEnv("DEV_REVIEW_HOME", home);
      const token = "fixture-secret";
      const server = createGlobalReviewServer({
        appPid: process.pid,
        packageRoot,
        toolingRoot: packageRoot,
        port: 0,
        token,
        discoveryPath: path.join(home, "desktop.json"),
      });
      try {
        await server.listen();
        const request = (route: string, body?: JsonObject) =>
          fetch(new URL(route, server.url), {
            method: body ? "POST" : "GET",
            headers: {
              "x-review-token": token,
              "content-type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          });
        const opened = await request(`/reviews/${uuid}/open`, {});
        expect(opened.status).toBe(201);
        const session = await opened.json();
        const prefix = `/sessions/${session.sessionId}/__progressive-review`;
        const documentResponse = await request(`${prefix}/document`);
        expect(documentResponse.status).toBe(200);
        const document = await documentResponse.json();
        const golden = reviewDocumentDataSchema.parse(
          await readLegacyReviewGolden(fixture.name, "document"),
        );
        expect(document).toMatchObject({
          ok: true,
          contentHash: bundleReviewDocument(golden).contentHash,
        });
        expect(await (await request(document.documentUrl)).json()).toEqual(
          golden,
        );
        const mapResponse = await request(`${prefix}/software-map`);
        expect(mapResponse.status).toBe(fixture.hasMap ? 200 : 404);
        const map = await mapResponse.json();
        const mapGolden = fixture.hasMap
          ? await readLegacyReviewGolden(fixture.name, "map")
          : null;
        expect(map).toMatchObject(
          fixture.hasMap
            ? { ok: true, contentHash: (mapGolden as JsonObject).contentHash }
            : { ok: false, error: "Software map is not published" },
        );
        expect((await request(`${prefix}/comments`)).status).toBe(200);
        const diff = await request(`${prefix}/diff-files`, {});
        expect(await diff.json()).toMatchObject({ ok: true });
        const listed = await (await request("/reviews")).json();
        expect(listed.errors).toEqual([]);
        expect(listed.reviews).toHaveLength(1);
        expect(listed.reviews[0]).toMatchObject({ uuid, available: true });
        expect(listed.reviews[0]).not.toHaveProperty("recovery");
      } finally {
        await server.close();
        closeAllReviewThreadStores();
        vi.unstubAllEnvs();
      }
    }, 60_000);
  }
});

/** The pointer as the database holds it right now. */
function presentedDocumentRevision(reviewDir: string): string | null {
  const record = readReviewRecord(reviewDir);
  return record === null
    ? null
    : parseStoredReviewRecord(record).presentedDocumentRevision;
}

/** The publication ID an event reports. */
function revisionOf(
  result: ReviewPublicationResult,
  event: "document-published" | "map-published",
): string {
  const published = result.events.find((entry) => entry.event === event);
  if (published?.event !== event)
    throw new Error(`No ${event} in the publication result.`);
  return published.revision;
}

function sessionIdOf(result: ReviewPublicationResult): string {
  const published = result.events.find(
    (entry) => entry.event === "document-published",
  );
  if (published?.event !== "document-published")
    throw new Error("No document-published in the publication result.");
  return published.sessionId;
}

/** The public content hash the session reports for a stored map publication. */
async function mapContentHash(
  reviewDir: string,
  publicationId: string,
): Promise<string> {
  const row = readPublication(reviewDir, publicationId, "map");
  if (!row) throw new Error(`No map publication ${publicationId}.`);
  const record = parsePublicationRecord(row.record);
  if (record.kind !== "map" || record.artifact.state !== "stored")
    throw new Error(`Map publication ${publicationId} has no stored artifact.`);
  const bundle = await readReviewSoftwareMapArtifact(
    reviewDir,
    record.artifact.hash,
  );
  if (!bundle)
    throw new Error(`Map artifact ${record.artifact.hash} is unavailable.`);
  return bundle.contentHash;
}

function commitFile(root: string, name: string): string {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  writeFileSync(path.join(root, name), `export const ${"added"} = true;\n`);
  git(["add", name]);
  git(["commit", "-qm", name]);
  return git(["rev-parse", "HEAD"]);
}

async function makeSourceRepository(parent: string) {
  const root = path.join(parent, "source");
  await mkdir(root, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "Initial"]);
  return { root, commit: git(["rev-parse", "HEAD"]) };
}
