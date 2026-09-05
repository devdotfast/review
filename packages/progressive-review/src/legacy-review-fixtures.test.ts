import { execFile } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  ReviewCommentThreadRecordSchema,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  normalizeMigratedRecord,
  readLegacyReviewGolden,
  snapshotReviewTree,
} from "./fixtures/legacy-reviews/legacy-review-fixture";
import { readReviewDocumentBundle } from "./review-bundle";
import {
  findReview,
  listReviews,
  materializeReviewRevision,
  readStoredReview,
  sealReviewCandidate,
} from "./review-home";
import {
  appendReviewComment,
  appendReviewCommentDraft,
} from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import { readReviewSoftwareMapBundle } from "./software-map-bundle";

const execFilePromise = promisify(execFile);
const fixtures = await listLegacyReviewFixtures();
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function extract(name: string) {
  const extracted = await extractLegacyReviewFixture(name);
  tempRoots.push(extracted.home);
  vi.stubEnv("DEV_REVIEW_HOME", extracted.home);
  return extracted;
}

async function git(dir: string, args: string[]) {
  return (await execFilePromise("git", ["-C", dir, ...args])).stdout.trim();
}

function threadRows(dir: string) {
  const db = new DatabaseSync(path.join(dir, "review.db"), { readOnly: true });
  try {
    return {
      version: db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
      comments: db.prepare("SELECT * FROM comments ORDER BY thread_id").all(),
      drafts: db
        .prepare("SELECT * FROM comment_drafts ORDER BY thread_id")
        .all(),
    };
  } finally {
    db.close();
  }
}

it("includes the three approved public legacy fixtures", () => {
  expect(fixtures.map((fixture) => fixture.name)).toEqual([
    "schema4-bug-report-dialog",
    "schema4-opencode-agentserver",
    "schema4-three-minute-tour",
  ]);
});

describe.each(fixtures)("legacy fixture $name", (fixture) => {
  it("migrates to golden JSON while preserving metadata, threads and old history", async () => {
    const { home, dir, uuid, originalRecord } = await extract(fixture.name);
    const threadsBefore = threadRows(dir);
    const oldCommits = (await git(dir, ["rev-list", "--all"])).split("\n");
    const oldRefs = (
      await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).split("\n");
    const oldHead = await git(dir, ["rev-parse", "HEAD"]);
    const loaded = await readStoredReview(dir);
    expect("error" in loaded).toBe(false);
    const record = jsonObject(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    )!;
    expect(normalizeMigratedRecord(record)).toEqual(
      await readLegacyReviewGolden(fixture.name, "record"),
    );
    const preservedEntries = Object.entries(originalRecord).filter(
      ([key]) =>
        ![
          "schemaVersion",
          "presentedDocumentRevision",
          "presentedSoftwareMapRevision",
        ].includes(key),
    );
    for (const [key, value] of preservedEntries) {
      expect(record[key]).toEqual(value);
    }
    const documentRevision = record.presentedDocumentRevision as string;
    expect(documentRevision).not.toBe(originalRecord.presentedDocumentRevision);
    const documentDir = path.join(home, "document");
    await materializeReviewRevision(dir, documentRevision, documentDir);
    expect(
      (await readReviewDocumentBundle(documentDir, "/"))?.document,
    ).toEqual(await readLegacyReviewGolden(fixture.name, "document"));
    let actualMap = null;
    let expectedMap = null;
    if (fixture.hasMap) {
      const mapDir = path.join(home, "map");
      await materializeReviewRevision(
        dir,
        record.presentedSoftwareMapRevision as string,
        mapDir,
      );
      actualMap = await readReviewSoftwareMapBundle(mapDir);
      expectedMap = await readLegacyReviewGolden(fixture.name, "map");
    }
    expect(actualMap).toEqual(expectedMap);
    expect(Boolean(record.presentedSoftwareMapRevision)).toBe(fixture.hasMap);
    for (const revision of oldCommits)
      expect(await reviewVcs.resolve(dir, revision)).toBe(revision);
    for (const entry of oldRefs) {
      const [ref, revision] = entry.split(" ");
      expect(await reviewVcs.resolve(dir, revision!)).toBe(revision);
      await git(dir, ["merge-base", "--is-ancestor", revision!, ref!]);
    }
    for (const entry of oldRefs.filter(
      (entry) => !entry.startsWith("refs/heads/main "),
    )) {
      const [ref, revision] = entry.split(" ");
      expect(await reviewVcs.resolve(dir, ref!)).toBe(revision);
    }
    let parentRevision = oldHead;
    const newRevisions = fixture.hasMap
      ? [record.presentedSoftwareMapRevision as string, documentRevision]
      : [documentRevision];
    for (const revision of newRevisions) {
      expect(
        (await git(dir, ["rev-list", "--parents", "-n", "1", revision]))
          .split(" ")
          .slice(1),
      ).toEqual([parentRevision]);
      parentRevision = revision;
    }
    const threadsAfter = threadRows(dir);
    expect(threadsAfter.version).toEqual({ value: "6" });
    expect(threadsAfter.comments).toEqual(threadsBefore.comments);
    expect(threadsAfter.drafts).toEqual(threadsBefore.drafts);
    const snapshot = await snapshotReviewTree(dir);
    expect(await readStoredReview(dir)).toEqual(loaded);
    expect(await listReviews()).toMatchObject({ errors: [] });
    expect((await findReview(uuid))?.review.schemaVersion).toBe(5);
    expect(await snapshotReviewTree(dir)).toEqual(snapshot);
  });

  it("migrates once when two readers race", async () => {
    const { dir } = await extract(fixture.name);
    const seal = vi.spyOn(reviewVcs, "seal");
    const [first, second] = await Promise.all([
      readStoredReview(dir),
      readStoredReview(dir),
    ]);
    expect("error" in first).toBe(false);
    expect(first).toEqual(second);
    expect(seal).toHaveBeenCalledTimes(fixture.hasMap ? 2 : 1);
  });

  it("reports repair without mutations for a corrupt sealed document", async () => {
    const { dir, uuid, originalRecord } = await extract(fixture.name);
    await writeFile(
      path.join(dir, ".bundle/document/review-document.js"),
      'throw new Error("corrupt sealed document");',
    );
    const brokenRevision = await sealReviewCandidate(
      dir,
      "Corrupt sealed document fixture",
    );
    await writeFile(
      path.join(dir, "review.json"),
      JSON.stringify({
        ...originalRecord,
        presentedDocumentRevision: brokenRevision,
      }),
    );
    const snapshot = await snapshotReviewTree(dir);
    const listed = await listReviews();
    expect(listed.reviews).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(listed.errors[0]).toMatchObject({
      code: "REPAIR_REQUIRED",
      reviewUuid: uuid,
    });
    expect(listed.errors[0]?.message).toContain(
      `review repair --review ${uuid}`,
    );
    expect(await snapshotReviewTree(dir)).toEqual(snapshot);
  });
});

it("lists healthy reviews alongside a corrupt sealed presentation", async () => {
  const healthy = await extract("schema4-bug-report-dialog");
  const broken = await extract("schema4-opencode-agentserver");
  await cp(healthy.dir, path.join(broken.home, "reviews", healthy.uuid), {
    recursive: true,
  });
  await writeFile(
    path.join(broken.dir, ".bundle/document/review-document.js"),
    'throw new Error("corrupt sealed document");',
  );
  const revision = await sealReviewCandidate(
    broken.dir,
    "Corrupt mixed-store fixture",
  );
  await writeFile(
    path.join(broken.dir, "review.json"),
    JSON.stringify({
      ...broken.originalRecord,
      presentedDocumentRevision: revision,
    }),
  );
  const snapshot = await snapshotReviewTree(broken.dir);

  const listed = await listReviews();

  expect(listed.reviews).toHaveLength(1);
  expect(listed.reviews[0]?.review).toMatchObject({
    uuid: healthy.uuid,
    schemaVersion: 5,
  });
  expect(listed.errors).toHaveLength(1);
  expect(listed.errors[0]).toMatchObject({
    code: "REPAIR_REQUIRED",
    reviewUuid: broken.uuid,
  });
  expect(await snapshotReviewTree(broken.dir)).toEqual(snapshot);
});

it("preserves seeded prose and code threads and a prose draft", async () => {
  const { dir, originalRecord } = await extract("schema4-bug-report-dialog");
  const reviewPath = path.join(dir, "review.mdx");
  const target = {
    kind: "text" as const,
    surface: {
      type: "block" as const,
      tag: "p",
      index: 0,
      blockHash: "abc12345",
    },
    selection: { start: 0, length: 5, hash: "f55c314b", quote: "Hello" },
  };
  appendReviewComment(reviewPath, {
    threadId: "prose-thread",
    messageId: "prose-message",
    target,
    body: "Preserve prose",
    author: "Fixture reviewer",
  });
  appendReviewCommentDraft(reviewPath, {
    threadId: "draft-thread",
    messageId: "draft-message",
    target,
    body: "Preserve draft",
    author: "Fixture reviewer",
  });
  closeAllReviewThreadStores();
  const position = {
    position_type: "text",
    base_sha: originalRecord.baseCommit,
    start_sha: originalRecord.baseCommit,
    head_sha: originalRecord.sourceCommit,
    old_path: "package.json",
    new_path: "package.json",
    old_line: 1,
    new_line: 1,
  };
  const codeThread = ReviewCommentThreadRecordSchema.parse({
    threadId: "code-thread",
    target: { kind: "code", original_position: position, position },
    status: "open",
    messages: [
      {
        id: "code-message",
        by: "Fixture reviewer",
        at: "2026-09-05T00:00:00.000Z",
        body: "Preserve code",
        agentInput: false,
      },
    ],
  });
  const db = new DatabaseSync(path.join(dir, "review.db"));
  try {
    db.prepare(
      "INSERT INTO comments(thread_id, record_json) VALUES (?, ?)",
    ).run(codeThread.threadId, JSON.stringify(codeThread));
  } finally {
    db.close();
  }
  const before = threadRows(dir);
  expect(before.comments).toHaveLength(2);
  expect(before.drafts).toHaveLength(1);
  const loaded = await readStoredReview(dir);
  expect("error" in loaded).toBe(false);
  expect(threadRows(dir)).toEqual(before);
});
