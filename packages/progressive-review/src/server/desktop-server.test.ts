import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, jsonObject } from "@dev.fast/review-protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  readLegacyReviewGolden,
} from "../fixtures/legacy-reviews/legacy-review-fixture";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { reviewDocumentDataSchema } from "../review-document-data";
import { createReviewDir, reviewTitleFromDocument } from "../review-home";
import { putReviewRecord } from "../review-state-db";
import { appendReviewComment } from "../review-state-store";
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
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay";

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

it("rejects a publication whose review moved its base ref during the command", async () => {
  directory = await mkdtemp(path.join(tmpdir(), "review-publish-race-"));
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  const source = await makeSourceRepository(directory);

  const stored = await createReviewDir({
    worktreePath: source.root,
    baseRef: "main",
    baseCommit: source.commit,
    sourceCommit: source.commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });

  await writeReviewDocumentBundle(
    stored.dir,
    bundleReviewDocument({
      format: "review-document/1",
      title: "Concurrent publication",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }),
  );
  const revision = await reviewVcs.seal(stored.dir, "Review publish candidate");
  const relay = new GlobalReviewDesktopVerbRelay();
  relay.dispatch = async (_sessionId, verb) => {
    if (jsonObject(verb)?.name === "validateCanvasMount") {
      await writeFile(
        path.join(stored.dir, "review.json"),
        JSON.stringify({ ...stored.review, baseRef: "release" }),
      );
      putReviewRecord(stored.dir, { ...stored.review, baseRef: "release" });
    }

    return { ok: true };
  };

  const token = "publication-race-secret";

  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(directory, "desktop.json"),
    relay,
  });

  try {
    await server.listen();

    const response = await fetch(`${server.url}/publish-ready`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": token,
      },
      body: JSON.stringify({ reviewUuid: stored.review.uuid, revision }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "review_publication_conflict",
    });
    await expect(
      readFile(path.join(stored.dir, "review.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      baseRef: "release",
      presentedDocumentRevision: null,
    });
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
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
      [fixture.baseCommit, fixture.sourceCommit].flatMap((commit) =>
        hasCommit(commit) ? [] : [`${fixture.name} ${commit}`],
      ),
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
