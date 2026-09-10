import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  REVIEW_SCHEMA_VERSION,
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readReviewDocumentBundle,
  reviewDocumentBundleData,
} from "./review-bundle";
import {
  ReviewHomeScanError,
  type StoredReview,
  bindReviewAuthorSession,
  computeSync,
  createReviewDir,
  findReview,
  findReviewForRepair,
  listReviews,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
  parseStoredReviewRecord,
  reviewDescriptor,
  reviewsHomeDir,
  sealReviewCandidate,
  touchReviewAgentSession,
  updateReviewPins,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { deleteReviewState } from "./review-state-db";
import { appendReviewComment, readReviewComments } from "./review-state-store";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome,
  tempDir,
  writeLegacyDocument,
} from "./review-test-utils";
import {
  closeAllReviewThreadStores,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import { resolvePublishReview } from "./server/publish-preparation";

const execFilePromise = promisify(execFile);

afterEach(async () => {
  closeAllReviewThreadStores();
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe("review home", () => {
  it("accepts every stored schema version and rejects unknown or extended records", async () => {
    const base = {
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "repo",
      worktreePath: "/repo",
      baseRef: "main",
      baseCommit: "b".repeat(40),
      sourceCommit: "a".repeat(40),
      sourceIdentity: null,
      title: "Review",
      status: "awaiting-review",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastPublishedAt: null,
    };
    expect(
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 2,
        agentSession: "disabled:review",
        presentedRevision: "c".repeat(40),
      }),
    ).toMatchObject({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      sourceSession: "disabled:review",
      presentedDocumentRevision: "c".repeat(40),
      presentedSoftwareMapRevision: "c".repeat(40),
    });
    expect(
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 3,
        agentSession: "disabled:review",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toMatchObject({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      sourceSession: "disabled:review",
    });
    expect(
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 4,
        sourceSession: "disabled:review",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toMatchObject({ schemaVersion: REVIEW_SCHEMA_VERSION });
    expect(
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: REVIEW_SCHEMA_VERSION,
        sourceSession: "disabled:review",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toMatchObject({ schemaVersion: REVIEW_SCHEMA_VERSION });
    expect(() =>
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 2,
        agentSession: "disabled:review",
        presentedRevision: null,
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toThrow(/presentedDocumentRevision/);
    expect(() =>
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 3,
        agentSession: 42,
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toThrow(/agentSession/);
    expect(() =>
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 1,
        sourceSession: "disabled:review",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
      }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      parseAnyStoredReviewRecord({
        ...base,
        schemaVersion: 4,
        sourceSession: "disabled:review",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
        unexpected: true,
      }),
    ).toThrow(/unexpected/);
  });

  it("atomically replaces a fresh marker with the durable author session", async () => {
    const root = await gitRepository();
    await reviewHome();
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
      sourceSession: "fresh:codex",
    });

    const bound = await bindReviewAuthorSession(
      created,
      { harness: "codex", sessionId: "tutorial-source" },
      "2026-08-26T10:00:00.000Z",
    );

    expect(bound.review.sourceSession).toBe("codex:tutorial-source");
    expect(bound.review.agentSessions?.["codex:tutorial-source"]).toEqual({
      roles: ["author"],
      firstSeenAt: "2026-08-26T10:00:00.000Z",
      lastSeenAt: "2026-08-26T10:00:00.000Z",
    });
    await expect(
      bindReviewAuthorSession(bound, {
        harness: "codex",
        sessionId: "another-source",
      }),
    ).rejects.toThrow("already bound");
  });

  it("upserts agent roles and timestamps without changing the legacy field", async () => {
    const root = await gitRepository();
    await reviewHome();
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
      sourceIdentity: { kind: "git-branch", name: "main" },
      sourceSession: "codex:creator",
    });
    const first = await touchReviewAgentSession(
      created,
      "codex:creator",
      "publisher",
      "2026-08-12T10:00:00.000Z",
    );
    const second = await touchReviewAgentSession(
      first,
      "codex:creator",
      "publisher",
      "2026-08-12T11:00:00.000Z",
    );
    expect(second.review.sourceSession).toBe("codex:creator");
    expect(second.review.agentSessions?.["codex:creator"]).toMatchObject({
      roles: ["author", "publisher"],
      firstSeenAt: created.review.createdAt,
      lastSeenAt: "2026-08-12T11:00:00.000Z",
    });
    const { agentSessions: _agentSessions, ...legacy } = second.review;
    expect(parseStoredReviewRecord(legacy)).not.toHaveProperty("agentSessions");
  });

  it("creates a UUID review directory with a plain Git repository", async () => {
    const root = await gitRepository();
    await reviewHome();

    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
      sourceCommit: await git(root, ["rev-parse", "HEAD"]),
      sourceIdentity: { kind: "git-branch", name: "main" },
      title: "Checkout review",
      sourceSession: "codex:agent-session",
    });

    expect(created.review).toMatchObject({
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      worktreePath: root,
      sourceIdentity: { kind: "git-branch", name: "main" },
      title: "Checkout review",
      sourceSession: "codex:agent-session",
      status: "draft",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      lastPublishedAt: null,
    });
    expect(created.dir).toBe(path.join(reviewsHomeDir(), created.review.uuid));
    expect(existsSync(path.join(created.dir, ".git"))).toBe(true);
    await expect(
      readFile(path.join(created.dir, "review.mdx"), "utf8"),
    ).resolves.toContain("# Checkout review");
    await expect(
      readFile(path.join(created.dir, "data.ts"), "utf8"),
    ).resolves.toBe("export {};\n");
    await expect(
      readFile(path.join(created.dir, ".gitignore"), "utf8"),
    ).resolves.toBe(".build/\nreview.db\nreview.db-wal\nreview.db-shm\n");
    await expect(
      readFile(path.join(created.dir, "package.json"), "utf8"),
    ).resolves.toContain('"test": "node review-test.mjs"');
    expect(existsSync(path.join(created.dir, "review.db"))).toBe(false);
    expect(existsSync(path.join(created.dir, "comments.json"))).toBe(false);
    expect(existsSync(path.join(created.dir, "questions.json"))).toBe(false);
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain(`"uuid": "${created.review.uuid}"`);
  });

  it("ignores a legacy softwareMap key in review.json", async () => {
    const root = await gitRepository();
    await reviewHome();

    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
    });
    const record = JSON.parse(
      await readFile(path.join(created.dir, "review.json"), "utf8"),
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...record,
        softwareMap: {
          languages: "typescript,go",
          graphDbPath: ".cache/review.sqlite",
        },
      }),
      "utf8",
    );
    const loaded = await findReview(created.review.uuid);

    expect(loaded?.review).not.toHaveProperty("softwareMap");
  });

  it("records the source binding in the creation write", async () => {
    const root = await gitRepository();
    await reviewHome();

    const created = await createReviewDir({
      uuid: "11111111-1111-4111-8111-111111111111",
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
      sourceCommit: "abcdef",
      sourceIdentity: { kind: "git-branch", name: "HEAD" },
    });

    expect(created.review).toMatchObject({
      sourceCommit: "abcdef",
      sourceIdentity: { kind: "git-branch", name: "HEAD" },
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"sourceCommit": "abcdef"');
  });

  it("records explicit pull request identity in the creation write", async () => {
    const root = await gitRepository();
    await reviewHome();

    const created = await createReviewDir({
      uuid: "11111111-1111-4111-8111-111111111111",
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
      sourceCommit: "abcdef",
      sourceIdentity: { kind: "git-branch", name: "HEAD" },
      pullRequestNumber: 673,
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
    });

    expect(created.review).toMatchObject({
      pullRequestNumber: 673,
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"pullRequestNumber": 673');
  });

  it("describes pull request, diff, and comment metadata for the home view", async () => {
    const root = await gitRepository();
    await reviewHome();

    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "feature.ts"), "export const value = 1;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "add feature"]);
    const sourceCommit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: baseCommit,
      baseCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "feature/home" },
      pullRequestNumber: 673,
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
    });
    appendReviewComment(path.join(created.dir, "review.mdx"), {
      threadId: "thread-1",
      messageId: "message-1",
      target: { kind: "document" },
      body: "Review this.",
      author: "reviewer",
    });
    const documentUpdatedAt = (
      await stat(path.join(created.dir, "review.mdx"))
    ).mtime.toISOString();

    await expect(reviewDescriptor(created)).resolves.toMatchObject({
      baseRef: baseCommit,
      headRef: "feature/home",
      commits: [
        {
          commit: sourceCommit,
          parentCommit: baseCommit,
          subject: "add feature",
          fileCount: 1,
          additions: 1,
          deletions: 0,
        },
      ],
      pullRequestNumber: 673,
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
      diffStats: { fileCount: 1, additions: 1, deletions: 0 },
      commentCount: 1,
      documentUpdatedAt,
    });
  });

  it("rejects a read-only descriptor when the review has no thread database", async () => {
    const root = await gitRepository();
    await reviewHome();
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: baseCommit,
      baseCommit,
      sourceCommit: baseCommit,
    });
    await rm(reviewThreadDbPath(path.join(created.dir, "review.mdx")));
    await expect(
      reviewDescriptor(created, { threads: "read-only" }),
    ).rejects.toThrow("thread database is unavailable");
    await expect(reviewDescriptor(created)).resolves.toMatchObject({
      commentCount: 0,
    });
  });

  it("describes the pinned diff even when the checkout moved elsewhere", async () => {
    const root = await gitRepository();
    await reviewHome();

    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "-b", "review-head"]);
    await writeFile(
      path.join(root, "reviewed.ts"),
      "export const reviewed = true;\nexport const ready = true;\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "reviewed change"]);
    const reviewHead = await git(root, ["rev-parse", "HEAD"]);

    await git(root, ["checkout", "-b", "unrelated-checkout", baseCommit]);
    await writeFile(
      path.join(root, "unrelated.ts"),
      Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "unrelated checkout"]);

    const created = await createReviewDir({
      worktreePath: root,
      baseRef: baseCommit,
      baseCommit,
      sourceCommit: reviewHead,
      sourceIdentity: { kind: "git-branch", name: "review-head" },
      pullRequestNumber: 636,
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/636",
    });

    await expect(reviewDescriptor(created)).resolves.toMatchObject({
      diffStats: { fileCount: 1, additions: 2, deletions: 0 },
      commits: [
        {
          commit: reviewHead,
          parentCommit: baseCommit,
          subject: "reviewed change",
        },
      ],
    });

    const samePin = await createReviewDir({
      worktreePath: root,
      baseRef: baseCommit,
      baseCommit,
      sourceCommit: baseCommit,
      sourceIdentity: { kind: "git-branch", name: "review-head" },
    });

    await expect(reviewDescriptor(samePin)).resolves.toMatchObject({
      diffStats: null,
      commits: [],
    });
  });

  it("remaps code threads when the pinned head moves and keeps outdated threads detached", async () => {
    const root = await gitRepository();
    await reviewHome();

    await writeFile(
      path.join(root, "example.ts"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "add example"]);
    const originalCommit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: originalCommit,
      sourceCommit: originalCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    const reviewPath = path.join(created.dir, "review.mdx");
    const originalPosition = createGitLabTextDiffPosition({
      base_sha: originalCommit,
      start_sha: originalCommit,
      head_sha: originalCommit,
      old_path: "example.ts",
      new_path: "example.ts",
      start: { old_line: null, new_line: 8 },
      end: { old_line: null, new_line: 9 },
    });
    const originalTarget = {
      kind: "code" as const,
      original_position: originalPosition,
      position: originalPosition,
    };
    appendReviewComment(reviewPath, {
      threadId: "thread-1",
      messageId: "message-1",
      target: originalTarget,
      body: "Keep this range",
      author: "Reviewer",
    });

    await git(root, ["mv", "example.ts", "renamed.ts"]);
    await writeFile(
      path.join(root, "renamed.ts"),
      "one\ninserted one\ninserted two\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "insert lines"]);
    const movedCommit = await git(root, ["rev-parse", "HEAD"]);
    const movedReview = await updateReviewPins(created, {
      baseRef: "main",
      baseCommit: originalCommit,
      sourceCommit: movedCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
      sourceSession: created.review.sourceSession,
    });
    const moved = readReviewComments(reviewPath)["thread-1"]!;
    if (moved.target.kind !== "code") throw new Error("Expected code target.");
    expect(moved.target.original_position).toEqual(originalPosition);
    expect(moved.target.position).toMatchObject({
      head_sha: movedCommit,
      new_path: "renamed.ts",
    });
    expect(gitLabDiffPositionRows(moved.target.position)).toEqual({
      start: { old_line: null, new_line: 10 },
      end: { old_line: null, new_line: 11 },
    });

    await writeFile(
      path.join(root, "renamed.ts"),
      "one\ninserted one\ninserted two\ntwo\nthree\nfour\nfive\nsix\nseven\nchanged\nnine\nten\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "change selected line"]);
    const changedCommit = await git(root, ["rev-parse", "HEAD"]);
    const outdatedReview = await updateReviewPins(movedReview, {
      baseRef: "main",
      baseCommit: originalCommit,
      sourceCommit: changedCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
      sourceSession: movedReview.review.sourceSession,
    });
    const outdated = readReviewComments(reviewPath)["thread-1"]!;
    if (outdated.target.kind !== "code") {
      throw new Error("Expected code target.");
    }
    expect(outdated.target.position).toEqual(moved.target.position);
    expect(outdated.target.change_position).toMatchObject({
      head_sha: changedCommit,
      new_path: "renamed.ts",
    });

    await writeFile(
      path.join(root, "renamed.ts"),
      "one\ninserted one\ninserted two\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "restore selected line"]);
    const restoredCommit = await git(root, ["rev-parse", "HEAD"]);
    await updateReviewPins(outdatedReview, {
      baseRef: "main",
      baseCommit: originalCommit,
      sourceCommit: restoredCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
      sourceSession: outdatedReview.review.sourceSession,
    });
    const stillOutdated = readReviewComments(reviewPath)["thread-1"]!;
    if (stillOutdated.target.kind !== "code") {
      throw new Error("Expected code target.");
    }
    expect(stillOutdated.target.position).toEqual(moved.target.position);
    expect(stillOutdated.target.change_position).toMatchObject({
      head_sha: restoredCommit,
      new_path: "renamed.ts",
    });
  });

  it("ignores active and stale locks and unrelated directories during discovery", async () => {
    const root = await gitRepository();
    await reviewHome();
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
    });
    const staleReviewDir = path.join(
      reviewsHomeDir(),
      "11111111-1111-4111-8111-111111111111",
    );
    const staleLock = `${staleReviewDir}.mutation-lock`;
    const unrelated = path.join(reviewsHomeDir(), "notes");
    await mkdir(staleLock);
    await utimes(staleLock, new Date(0), new Date(0));
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "review.json"), "not a Review");
    await withReviewMutationLock(created.dir, () =>
      withReviewMutationLock(
        path.join(reviewsHomeDir(), "tutorial-lifecycle"),
        async () => {
          const homeListing = await listReviews();
          expect(homeListing.errors).toEqual([]);
          expect(homeListing.reviews.map((entry) => entry.review.uuid)).toEqual(
            [created.review.uuid],
          );
          const scoped = await listReviews({ worktreePath: root });
          expect(scoped.errors).toEqual([]);
          expect(scoped.reviews.map((entry) => entry.review.uuid)).toEqual([
            created.review.uuid,
          ]);
          await expect(
            resolvePublishReview(root, created.review.uuid),
          ).resolves.toMatchObject({ dir: created.dir });
          expect(existsSync(staleLock)).toBe(true);
          expect(
            await readFile(path.join(unrelated, "review.json"), "utf8"),
          ).toBe("not a Review");
        },
      ),
    );
    await expect(
      withReviewMutationLock(staleReviewDir, async () => "reclaimed"),
    ).resolves.toBe("reclaimed");
    expect(existsSync(staleLock)).toBe(false);
  });

  it("returns parse failures as explicit list errors", async () => {
    await reviewHome();
    const malformedUuid = "33333333-3333-4333-8333-333333333333";
    const invalidUuid = "44444444-4444-4444-8444-444444444444";
    const malformed = path.join(reviewsHomeDir(), malformedUuid);
    const invalid = path.join(reviewsHomeDir(), invalidUuid);
    const incompatibleUuid = "22222222-2222-4222-8222-222222222222";
    const incompatible = path.join(reviewsHomeDir(), incompatibleUuid);
    await mkdir(malformed, { recursive: true });
    await mkdir(invalid, { recursive: true });
    await mkdir(incompatible, { recursive: true });
    await writeFile(path.join(malformed, "review.json"), "{nope", "utf8");
    await writeFile(path.join(invalid, "review.json"), "{}", "utf8");
    await writeFile(
      path.join(incompatible, "review.json"),
      JSON.stringify({
        schemaVersion: 2,
        uuid: incompatibleUuid,
        title: "An incompatible Review",
        worktreePath: "/tmp/incompatible",
        lastPublishedAt: "2026-08-08T00:00:00.000Z",
      }),
      "utf8",
    );

    const result = await listReviews();
    expect(result.reviews).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        {
          reviewDir: malformed,
          reviewUuid: malformedUuid,
          title: "",
          worktreePath: malformed,
          lastPublishedAt: null,
          message: expect.stringContaining("Could not read review.json"),
        },
        {
          reviewDir: invalid,
          reviewUuid: invalidUuid,
          title: "",
          worktreePath: invalid,
          lastPublishedAt: null,
          code: "MIGRATION_REQUIRED",
          message: expect.stringContaining("review migrate apply"),
        },
        {
          reviewDir: incompatible,
          reviewUuid: incompatibleUuid,
          title: "An incompatible Review",
          worktreePath: "/tmp/incompatible",
          lastPublishedAt: "2026-08-08T00:00:00.000Z",
          code: "MIGRATION_REQUIRED",
          message: expect.stringContaining("review migrate apply"),
        },
      ]),
    );
  });

  it("distinguishes invalid UUIDs, missing reviews, and malformed records", async () => {
    await reviewHome();
    const malformedUuid = "22222222-2222-4222-8222-222222222222";
    const malformedDir = path.join(reviewsHomeDir(), malformedUuid);
    await mkdir(malformedDir, { recursive: true });
    await writeFile(path.join(malformedDir, "review.json"), "ENOENT", "utf8");

    await expect(findReview("not-a-uuid")).rejects.toThrow(
      "Review UUID is invalid: not-a-uuid",
    );
    await expect(
      findReview("11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeNull();
    await expect(findReview(malformedUuid)).rejects.toBeInstanceOf(
      ReviewHomeScanError,
    );
  });

  it("filters scanned reviews and computes source-head sync", async () => {
    const root = await gitRepository();
    const otherRoot = await gitRepository();
    await reviewHome();

    const sourceCommit = await git(root, ["rev-parse", "HEAD"]);
    const review = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
    });
    await createReviewDir({
      worktreePath: otherRoot,
      baseRef: "main",
      baseCommit: await git(otherRoot, ["rev-parse", "HEAD"]),
      sourceCommit: await git(otherRoot, ["rev-parse", "HEAD"]),
    });

    await expect(listReviews({ worktreePath: root })).resolves.toMatchObject({
      reviews: [{ dir: review.dir, review: { uuid: review.review.uuid } }],
      errors: [],
    });
    await expect(computeSync(review.review, root)).resolves.toBe(true);
    await writeFile(path.join(root, "next.txt"), "next\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "next"]);
    // computeSync compares the resolved head commit, not a time window: the
    // new commit is observable the moment `git commit` returns.
    await expect(computeSync(review.review, root)).resolves.toBe(false);
  });

  it("keeps system Reviews addressable but out of ordinary lists", async () => {
    const root = await gitRepository();
    await reviewHome();

    const sourceCommit = await git(root, ["rev-parse", "HEAD"]);
    const review = await createReviewDir({
      visibility: "system",
      worktreePath: root,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
    });

    await expect(listReviews()).resolves.toMatchObject({
      reviews: [],
      errors: [],
    });
    await expect(listReviews({ includeSystem: true })).resolves.toMatchObject({
      reviews: [
        {
          dir: review.dir,
          review: { uuid: review.review.uuid, visibility: "system" },
        },
      ],
      errors: [],
    });
    await expect(findReview(review.review.uuid)).resolves.toMatchObject({
      dir: review.dir,
      review: { visibility: "system" },
    });
  });

  it("reports an unresolvable worktree head instead of calling it out of sync", async () => {
    const root = await tempDir("review-home-source-");
    await reviewHome();

    const review = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: "base",
      sourceCommit: "bound-head",
    });

    await expect(computeSync(review.review, root)).rejects.toThrow(
      `Could not resolve the current source head at ${root}.`,
    );
  });
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("legacy records on read", () => {
  it("reads repair metadata without migration and preserves lookup validation", async () => {
    const root = await gitRepository();
    await reviewHome();
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
    });
    const recordPath = path.join(created.dir, "review.json");
    const record = await legacyRecord(created, 4, "a".repeat(40));
    const bytes = JSON.stringify(record);
    await writeFile(recordPath, bytes);
    const loaded = await findReviewForRepair(created.review.uuid);
    expect(loaded).toMatchObject({
      dir: created.dir,
      review: { schemaVersion: 5, presentedDocumentRevision: "a".repeat(40) },
    });
    expect(loaded).not.toHaveProperty("recovery");
    expect(await readFile(recordPath, "utf8")).toBe(bytes);
    for (const value of [
      "{broken",
      JSON.stringify({ ...record, baseCommit: 42 }),
      JSON.stringify({ ...record, schemaVersion: 6 }),
      JSON.stringify({
        ...record,
        uuid: "11111111-1111-4111-8111-111111111111",
      }),
    ]) {
      deleteReviewState(created.dir);
      await writeFile(recordPath, value);
      await expect(
        findReviewForRepair(created.review.uuid),
      ).rejects.toBeInstanceOf(ReviewHomeScanError);
      expect(await readFile(recordPath, "utf8")).toBe(value);
    }
    await expect(findReviewForRepair("not-a-uuid")).rejects.toThrow(
      "Review UUID is invalid",
    );
    await expect(
      findReviewForRepair("22222222-2222-4222-8222-222222222222"),
    ).resolves.toBeNull();
  });
  it.each([2, 3, 4, 6] as const)(
    "does not mutate malformed or unsupported schema %s records",
    async (schemaVersion) => {
      const root = await gitRepository();
      await reviewHome();
      const created = await createReviewDir({
        worktreePath: root,
        baseRef: "main",
        baseCommit: await git(root, ["rev-parse", "HEAD"]),
      });
      const recordPath = path.join(created.dir, "review.json");
      await sealReviewCandidate(created.dir, "Initial document");
      const record = await legacyRecord(
        created,
        schemaVersion === 6 ? 4 : schemaVersion,
        "a".repeat(40),
      );
      const bytes = JSON.stringify(
        schemaVersion === 6
          ? { ...created.review, schemaVersion }
          : {
              ...record,
              schemaVersion,
              baseCommit: 42,
              agentSession: "codex",
            },
      );
      await writeFile(recordPath, bytes);
      const refs = await git(created.dir, ["rev-parse", "HEAD"]);
      const listed = await listReviews();
      expect(listed.reviews).toEqual([]);
      expect(listed.errors).toMatchObject([{ code: "MIGRATION_REQUIRED" }]);
      await expect(findReview(created.review.uuid)).rejects.toBeInstanceOf(
        ReviewHomeScanError,
      );
      expect(await readFile(recordPath, "utf8")).toBe(bytes);
      expect(await git(created.dir, ["rev-parse", "HEAD"])).toBe(refs);
    },
  );

  it.each([2, 3, 4] as const)(
    "migrates a schema %s record on first read and lists it as current",
    async (schemaVersion) => {
      const root = await gitRepository();
      const home = await reviewHome();
      const created = await createReviewDir({
        worktreePath: root,
        baseRef: "main",
        baseCommit: await git(root, ["rev-parse", "HEAD"]),
      });
      await writeLegacyDocument(created.dir);
      const revision = await sealReviewCandidate(
        created.dir,
        "Legacy document",
      );
      const recordPath = path.join(created.dir, "review.json");
      await writeFile(
        recordPath,
        JSON.stringify(await legacyRecord(created, schemaVersion, revision)),
      );

      const listed = await listReviews();

      expect(listed.errors).toEqual([]);
      expect(listed.reviews).toHaveLength(1);
      const stored = await findReview(created.review.uuid);
      expect(stored?.review).toMatchObject({
        schemaVersion: 5,
        status: "accepted",
        dismissedAt: "2026-01-01T00:00:00Z",
        sourceSession: created.review.sourceSession,
      });
      expect(stored?.review.presentedDocumentRevision).not.toBe(revision);
      expect(stored?.review.presentedSoftwareMapRevision).toBeNull();
      const materialized = path.join(home, "materialized");
      await materializeReviewRevision(
        created.dir,
        stored!.review.presentedDocumentRevision!,
        materialized,
      );
      const bundle = await readReviewDocumentBundle(materialized, "/");
      expect(bundle && reviewDocumentBundleData(bundle).title).toBe("Sealed");
      expect(await reviewDescriptor(stored!)).toMatchObject({
        available: true,
        status: "accepted",
      });

      const bytes = await readFile(recordPath, "utf8");
      await listReviews();
      expect(await readFile(recordPath, "utf8")).toBe(bytes);
    },
  );

  it("migrates once when two readers race", async () => {
    const root = await gitRepository();
    await reviewHome();
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
    });
    await writeLegacyDocument(created.dir);
    const revision = await sealReviewCandidate(created.dir, "Legacy document");
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify(await legacyRecord(created, 4, revision)),
    );
    const seal = vi.spyOn(reviewVcs, "seal");

    const [first, second] = await Promise.all([
      findReview(created.review.uuid),
      findReview(created.review.uuid),
    ]);

    expect(first?.review.schemaVersion).toBe(5);
    expect(second?.review).toEqual(first?.review);
    expect(seal).toHaveBeenCalledTimes(1);
  });

  it("reports repair without touching a review whose sealed document is broken", async () => {
    const root = await gitRepository();
    await reviewHome();
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "HEAD"]),
    });
    await writeLegacyDocument(created.dir, {
      code: 'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    });
    const revision = await sealReviewCandidate(created.dir, "Broken document");
    const recordPath = path.join(created.dir, "review.json");
    const bytes = JSON.stringify(await legacyRecord(created, 4, revision));
    await writeFile(recordPath, bytes);
    const refs = await readFile(path.join(created.dir, ".git/refs/heads/main"));

    const listed = await listReviews();

    expect(listed.reviews).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(listed.errors[0]).toMatchObject({
      code: "REPAIR_REQUIRED",
      reviewUuid: created.review.uuid,
    });
    expect(listed.errors[0]?.message).toContain(
      `review repair --review ${created.review.uuid}`,
    );
    await expect(findReview(created.review.uuid)).rejects.toThrow(
      "review repair --review",
    );
    await expect(findReview(created.review.uuid)).rejects.toMatchObject({
      errors: [{ code: "REPAIR_REQUIRED" }],
    });
    expect(await readFile(recordPath, "utf8")).toBe(bytes);
    expect(
      await readFile(path.join(created.dir, ".git/refs/heads/main")),
    ).toEqual(refs);
  });
});

async function legacyRecord(
  created: StoredReview,
  schemaVersion: 2 | 3 | 4,
  revision: string,
) {
  deleteReviewState(created.dir);
  const {
    sourceSession,
    presentedDocumentRevision: _document,
    presentedSoftwareMapRevision: _map,
    ...common
  } = created.review;
  return {
    ...common,
    schemaVersion,
    status: "accepted",
    dismissedAt: "2026-01-01T00:00:00Z",
    ...(schemaVersion === 4
      ? { sourceSession }
      : { agentSession: sourceSession }),
    ...(schemaVersion === 2
      ? { presentedRevision: revision }
      : {
          presentedDocumentRevision: revision,
          presentedSoftwareMapRevision: null,
        }),
  };
}
