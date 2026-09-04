import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createGitLabTextDiffPosition,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ReviewHomeScanError,
  bindReviewAuthorSession,
  computeSync,
  createReviewDir,
  findReview,
  listReviews,
  parseStoredReviewRecord,
  readReviewRecord,
  reviewDescriptor,
  reviewsHomeDir,
  touchReviewAgentSession,
  updateReviewPins,
} from "./review-home";
import { deleteReviewState, reviewStateDbPath } from "./review-state-db";
import { appendReviewComment, readReviewComments } from "./review-state-store";

const execFilePromise = promisify(execFile);

describe("review home", () => {
  it("binds a previously unbound Review", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
      const commit = await git(root, ["rev-parse", "HEAD"]);
      const created = await createReviewDir({
        worktreePath: root,
        baseRef: "main",
        baseCommit: commit,
        sourceCommit: commit,
      });

      const bound = await bindReviewAuthorSession(created, {
        harness: "codex",
        sessionId: "live-source",
      });

      expect(bound.review.sourceSession).toBe("codex:live-source");
      expect(bound.review.agentSessions).toMatchObject({
        "codex:live-source": { roles: ["author"] },
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a fresh marker with the durable author session", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
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
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upserts agent roles and timestamps without changing the legacy field", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
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
      expect(parseStoredReviewRecord(legacy)).not.toHaveProperty(
        "agentSessions",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a UUID review directory with a plain Git repository", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      expect(created.dir).toBe(
        path.join(reviewsHomeDir(), created.review.uuid),
      );
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
      expect(existsSync(reviewStateDbPath(home))).toBe(true);
      expect(existsSync(path.join(created.dir, "review.db"))).toBe(false);
      expect(existsSync(path.join(created.dir, "comments.json"))).toBe(false);
      expect(existsSync(path.join(created.dir, "questions.json"))).toBe(false);
      expect(existsSync(path.join(created.dir, "review.json"))).toBe(false);
      expect(readReviewRecord(created.dir).uuid).toBe(created.review.uuid);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a legacy softwareMap key in review.json", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const created = await createReviewDir({
        worktreePath: root,
        baseRef: "main",
        baseCommit: await git(root, ["rev-parse", "HEAD"]),
      });
      const record = readReviewRecord(created.dir);
      deleteReviewState(created.dir);
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
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the source binding in the creation write", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      expect(readReviewRecord(created.dir).sourceCommit).toBe("abcdef");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records explicit pull request identity in the creation write", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      expect(readReviewRecord(created.dir).pullRequestNumber).toBe(673);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes pull request, diff, and comment metadata for the home view", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const baseCommit = await git(root, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(root, "feature.ts"),
        "export const value = 1;\n",
      );
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
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes the pinned diff even when the checkout moved elsewhere", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("remaps code threads when the pinned head moves and keeps outdated threads detached", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      if (moved.target.kind !== "code")
        throw new Error("Expected code target.");
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
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns parse failures as explicit list errors", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const malformed = path.join(reviewsHomeDir(), "not-a-review");
    const invalid = path.join(reviewsHomeDir(), "invalid-review");
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

    try {
      const result = await listReviews();
      expect(result.reviews).toEqual([]);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          {
            reviewDir: malformed,
            reviewUuid: null,
            title: "",
            worktreePath: malformed,
            lastPublishedAt: null,
            message: expect.stringContaining("Could not import legacy Review"),
          },
          {
            reviewDir: invalid,
            reviewUuid: null,
            title: "",
            worktreePath: invalid,
            lastPublishedAt: null,
            code: "MIGRATION_REQUIRED",
            message: expect.stringContaining("Invalid stored Review"),
          },
          {
            reviewDir: incompatible,
            reviewUuid: incompatibleUuid,
            title: "An incompatible Review",
            worktreePath: "/tmp/incompatible",
            lastPublishedAt: "2026-08-08T00:00:00.000Z",
            code: "MIGRATION_REQUIRED",
            message: expect.stringContaining("Invalid stored Review"),
          },
        ]),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("distinguishes invalid UUIDs, missing reviews, and malformed records", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const malformedUuid = "22222222-2222-4222-8222-222222222222";
    const malformedDir = path.join(reviewsHomeDir(), malformedUuid);
    await mkdir(malformedDir, { recursive: true });
    await writeFile(path.join(malformedDir, "review.json"), "ENOENT", "utf8");

    try {
      await expect(findReview("not-a-uuid")).rejects.toThrow(
        "Review UUID is invalid: not-a-uuid",
      );
      await expect(
        findReview("11111111-1111-4111-8111-111111111111"),
      ).resolves.toBeNull();
      await expect(findReview(malformedUuid)).rejects.toBeInstanceOf(
        ReviewHomeScanError,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("filters scanned reviews and computes source-head sync", async () => {
    const root = await makeGitRepository();
    const otherRoot = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      await new Promise((resolve) => setTimeout(resolve, 4_100));
      await expect(computeSync(review.review, root)).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("keeps system Reviews addressable but out of ordinary lists", async () => {
    const root = await makeGitRepository();
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
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
      await expect(listReviews({ includeSystem: true })).resolves.toMatchObject(
        {
          reviews: [
            {
              dir: review.dir,
              review: { uuid: review.review.uuid, visibility: "system" },
            },
          ],
          errors: [],
        },
      );
      await expect(findReview(review.review.uuid)).resolves.toMatchObject({
        dir: review.dir,
        review: { visibility: "system" },
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unresolvable worktree head instead of calling it out of sync", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-home-source-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);

    try {
      const review = await createReviewDir({
        worktreePath: root,
        baseRef: "main",
        baseCommit: "base",
        sourceCommit: "bound-head",
      });

      await expect(computeSync(review.review, root)).rejects.toThrow(
        `Could not resolve the current source head at ${root}.`,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeGitRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-home-source-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "review@example.test"]);
  await git(root, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}
