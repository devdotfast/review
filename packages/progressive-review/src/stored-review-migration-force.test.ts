import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import { createReviewDir } from "./review-home";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  closeAllReviewThreadStores,
  createReviewThreadDb,
} from "./review-thread-store-backend";
import {
  migrateStoredReview,
  migrateStoredReviewData,
} from "./stored-review-migration";

const roots: string[] = [];
afterEach(async () => {
  closeAllReviewThreadStores();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each([4, 5])(
  "preserves unresolvable code records without force and reports explicit drops for schema %s",
  async (schemaVersion) => {
    const { reviewHome, reviewDir, dbPath } = await fixture(schemaVersion);
    const before = databaseRows(dbPath);
    const onDrop = vi.fn<() => void>();
    const blocked = await migrateStoredReview({
      reviewDir,
      onDropLegacyCodeRecord: onDrop,
    });
    expect(blocked.threadDbError).toBeTruthy();
    expect(blocked.upgradedThreadDb).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    expect(databaseRows(dbPath)).toEqual(before);
    const recordBeforeForce = await readFile(
      path.join(reviewDir, "review.json"),
      "utf8",
    );
    const log: string[] = [];
    const blockers: string[] = [];
    const forced = await migrateStoredReviewData({
      reviewHome,
      force: true,
      log: (message) => log.push(message),
      onBlocker: (message) => blockers.push(message),
    });
    expect(forced).toMatchObject({
      documents: 1,
      upgradedThreadDatabases: 1,
      droppedComments: 2,
      droppedQuestions: 0,
      droppedReviews: 0,
    });
    expect(blockers).toEqual([]);
    expect(
      log.filter((message) => message.startsWith("Dropped legacy")),
    ).toEqual([
      `Dropped legacy comment "bad-comment" from Review ${path.basename(reviewDir)}.`,
      `Dropped legacy comment-draft "bad-draft" from Review ${path.basename(reviewDir)}.`,
    ]);
    expect(log.join("\n")).not.toContain("private prose");
    expect(databaseRows(dbPath)).toEqual({
      version: String(REVIEW_THREAD_DB_SCHEMA_VERSION),
      comments: [
        {
          thread_id: "good",
          status: null,
          record_json: '{"target":{"kind":"document"},"messages":[]}',
        },
      ],
      drafts: [],
      questions: [
        { question_id: "question", record_json: '{"body":"private prose"}' },
      ],
    });
    expect(await readFile(path.join(reviewDir, "review.json"), "utf8")).toBe(
      recordBeforeForce,
    );
    const repeated = await migrateStoredReviewData({ reviewHome, force: true });
    expect(repeated).toMatchObject({
      upgradedThreadDatabases: 0,
      droppedComments: 0,
      droppedQuestions: 0,
    });
  },
);

it("does not report rolled-back drops as committed losses", async () => {
  const { reviewHome, dbPath } = await fixture(5);
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TRIGGER fail_upgrade BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
  );
  db.close();
  const before = databaseRows(dbPath);
  const log: string[] = [];
  const result = await migrateStoredReviewData({
    reviewHome,
    force: true,
    log: (message) => log.push(message),
  });
  expect(result).toMatchObject({
    upgradedThreadDatabases: 0,
    droppedComments: 0,
  });
  expect(log.filter((message) => message.startsWith("Dropped legacy"))).toEqual(
    [],
  );
  expect(databaseRows(dbPath)).toEqual(before);
});

function databaseRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      version: db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get()?.value,
      comments: db.prepare("SELECT * FROM comments ORDER BY thread_id").all(),
      drafts: db
        .prepare("SELECT * FROM comment_drafts ORDER BY thread_id")
        .all(),
      questions: db
        .prepare("SELECT * FROM questions ORDER BY question_id")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function fixture(schemaVersion: number) {
  const reviewHome = await mkdtemp(
    path.join(os.tmpdir(), "review-migration-force-"),
  );
  roots.push(reviewHome);
  const source = path.join(reviewHome, "source");
  await mkdir(source);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["config", "user.name", "Fixture"]);
  await writeFile(path.join(source, "README.md"), "source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const created = await createReviewDir({
    reviewsHomePath: reviewHome,
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
    sourceSession: "disabled:review",
  });
  await writeFile(
    path.join(created.dir, "review.json"),
    JSON.stringify({ ...created.review, schemaVersion }),
  );
  createReviewThreadDb(created.dir);
  closeAllReviewThreadStores();
  const dbPath = path.join(created.dir, "review.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "UPDATE meta SET value = '2' WHERE key = 'schema_version'; CREATE TABLE questions (question_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);",
  );
  const thread = {
    target: {
      kind: "code",
      path: "missing.ts",
      side: "head",
      commit: "missing-legacy-commit",
      span: { startLine: 1, endLine: 1 },
    },
    messages: [{ body: "private prose" }],
  };
  db.prepare("INSERT INTO comments VALUES (?, ?)").run(
    "bad-comment",
    JSON.stringify(thread),
  );
  db.prepare("INSERT INTO comments VALUES (?, ?)").run(
    "good",
    '{"target":{"kind":"document"},"messages":[]}',
  );
  db.prepare("INSERT INTO comment_drafts VALUES (?, ?)").run(
    "bad-draft",
    JSON.stringify({ thread }),
  );
  db.prepare("INSERT INTO questions VALUES (?, ?)").run(
    "question",
    '{"body":"private prose"}',
  );
  db.close();
  return { reviewHome, reviewDir: created.dir, dbPath };
}
