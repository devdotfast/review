import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  ReviewCommentDraftThreadSchema,
  ReviewCommentThreadRecordSchema,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  normalizeMigratedRecord,
  readLegacyReviewGolden,
  snapshotReviewTree,
} from "./fixtures/legacy-reviews/legacy-review-fixture";
import { sealLegacyReviewCommit } from "./fixtures/legacy-reviews/legacy-review-git";
import { legacyCompanionMapPublicationId } from "./legacy-review-import";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "./review-artifact-store";
import { reviewDocumentBundleData } from "./review-bundle";
import { findReview, listReviews, readStoredReview } from "./review-home";
import { parsePublicationRecord } from "./review-publication-record";
import {
  type ReviewPublicationRow,
  deleteReviewState,
  listPublications,
  readLegacyArtifactImport,
  reviewIdForDir,
} from "./review-state-db";
import {
  REVIEW_THREAD_DB_SCHEMA_VERSION,
  closeAllReviewThreadStores,
} from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";

const execFilePromise = promisify(execFile);
const fixtures = listLegacyReviewFixtures();
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

/** The Review tree without its thread database. A Review whose sealed
 * document cannot be converted still has its thread database migrated first —
 * the import refuses to read one at an older schema — so those files legitimately
 * change while every authored and sealed byte stays put. */
async function snapshotWithoutThreadDb(
  dir: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await snapshotReviewTree(dir)).filter(
      ([name]) => !name.startsWith("review.db"),
    ),
  );
}

/** Every commit the Git-era version listing offered: the publish candidates
 * from the presented revision back, plus the presented revision itself. */
async function publishCandidateCommits(
  dir: string,
  originalRecord: JsonObject,
): Promise<string[]> {
  const presented = originalRecord.presentedDocumentRevision;
  const log = await reviewVcs.log(dir);
  const index = log.findIndex((entry) => entry.oid === presented);
  return (index === -1 ? log : log.slice(index))
    .filter(
      (entry) =>
        entry.message === "Review publish candidate" || entry.oid === presented,
    )
    .map((entry) => entry.oid);
}

/** A revision that sealed its document and its map together needs a companion
 * map ID, because the document row already holds the commit; an independently
 * published map keeps its own commit as its publication ID. */
function expectedMapPublicationId(
  dir: string,
  documentPublicationId: JsonValue,
  row: ReviewPublicationRow | undefined,
): string | null {
  const commit = row?.legacyCommit ?? null;
  if (commit === null) return null;
  return commit === documentPublicationId
    ? legacyCompanionMapPublicationId(reviewIdForDir(dir), commit)
    : commit;
}

function publicationArtifactHash(
  row: ReviewPublicationRow | undefined,
): string {
  const record = parsePublicationRecord(row?.record ?? null);
  if (record.artifact.state !== "stored")
    throw new Error("The publication has no stored artifact.");
  return record.artifact.hash;
}

async function artifactOf(dir: string, row: ReviewPublicationRow | undefined) {
  const bundle = await readReviewDocumentArtifact(
    dir,
    publicationArtifactHash(row),
  );
  if (!bundle) throw new Error("The document artifact is missing.");
  return bundle;
}

function threadRows(dir: string) {
  const db = new DatabaseSync(path.join(dir, "review.db"), { readOnly: true });
  try {
    const rows = (table: "comments" | "comment_drafts") =>
      db
        .prepare(`SELECT * FROM ${table} ORDER BY thread_id`)
        .all()
        .map((row) => {
          return {
            ...row,
            record_json: parseJsonText(z.string().parse(row.record_json)),
          };
        });
    return {
      version: db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
      comments: rows("comments"),
      drafts: rows("comment_drafts"),
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

it("snapshots authored locks, databases, and managed metadata", async () => {
  const { dir } = await extract("schema4-bug-report-dialog");
  await writeFile(path.join(dir, "notes.lock"), "authored\n");
  await writeFile(path.join(dir, ".agent-sessions.lock"), "transient\n");
  await writeFile(path.join(dir, ".mutation-lock"), "transient\n");
  await writeFile(path.join(dir, "review.db-wal"), "database wal\n");
  await mkdir(path.join(dir, ".build"));
  await writeFile(path.join(dir, ".build", "generated.js"), "generated\n");

  const snapshot = await snapshotReviewTree(dir);

  expect(snapshot).toHaveProperty("notes.lock");
  expect(snapshot).toHaveProperty("review.db");
  expect(snapshot).toHaveProperty("review.db-wal");
  expect(snapshot).toHaveProperty("review.json");
  expect(Object.keys(snapshot).some((name) => name.startsWith(".git/"))).toBe(
    true,
  );
  expect(
    Object.keys(snapshot).some((name) => name.startsWith(".bundle/")),
  ).toBe(true);
  expect(snapshot).not.toHaveProperty(".agent-sessions.lock");
  expect(snapshot).not.toHaveProperty(".mutation-lock");
  expect(snapshot).not.toHaveProperty(".build/generated.js");
});

describe.each(fixtures)("legacy fixture $name", (fixture) => {
  it("imports to golden artifacts while preserving metadata, threads and old history", async () => {
    const { dir, uuid, originalRecord } = await extract(fixture.name);
    const threadsBefore = threadRows(dir);
    const oldCommits = (await git(dir, ["rev-list", "--all"])).split("\n");
    const oldRefs = (
      await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).split("\n");
    const candidates = await publishCandidateCommits(dir, originalRecord);
    const loaded = await readStoredReview(dir);
    expect("error" in loaded).toBe(false);
    const record = jsonObject(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    )!;
    expect(normalizeMigratedRecord(record)).toEqual(
      await readLegacyReviewGolden(fixture.name, "record"),
    );
    const preservedEntries = Object.entries(originalRecord).filter(
      // The map pointer is the one value the import may rewrite: a revision
      // that sealed document and map together needs a companion map ID.
      ([key]) =>
        !["schemaVersion", "presentedSoftwareMapRevision"].includes(key),
    );
    for (const [key, value] of preservedEntries) {
      expect(record[key]).toEqual(value);
    }
    // One row per published version, each keyed by the commit that sealed it,
    // so an existing link to a Git-era revision still names its publication.
    const documentRows = listPublications(dir, "document");
    expect(documentRows.map((row) => row.publicationId).sort()).toEqual(
      [...candidates].sort(),
    );
    expect(documentRows.map((row) => row.legacyCommit).sort()).toEqual(
      [...candidates].sort(),
    );
    expect(readLegacyArtifactImport(dir)).toMatchObject({
      versions: candidates.length,
      unavailable: 0,
    });
    expect(record.presentedDocumentRevision).toBe(
      originalRecord.presentedDocumentRevision,
    );
    const active = documentRows.find(
      (row) => row.publicationId === record.presentedDocumentRevision,
    );
    expect(reviewDocumentBundleData(await artifactOf(dir, active))).toEqual(
      await readLegacyReviewGolden(fixture.name, "document"),
    );
    const mapRows = listPublications(dir, "map");
    const activeMap = mapRows.find(
      (row) => row.publicationId === record.presentedSoftwareMapRevision,
    );
    expect(record.presentedSoftwareMapRevision).toBe(
      expectedMapPublicationId(
        dir,
        record.presentedDocumentRevision,
        activeMap,
      ),
    );
    expect(mapRows).toHaveLength(fixture.hasMap ? 1 : 0);
    const actualMap = activeMap
      ? await readReviewSoftwareMapArtifact(
          dir,
          publicationArtifactHash(activeMap),
        )
      : null;
    const expectedMap = fixture.hasMap
      ? await readLegacyReviewGolden(fixture.name, "map")
      : null;
    expect(actualMap).toEqual(expectedMap);
    for (const revision of oldCommits)
      expect(await reviewVcs.resolve(dir, revision)).toBe(revision);
    for (const entry of oldRefs) {
      const [ref, revision] = entry.split(" ");
      expect(await reviewVcs.resolve(dir, revision!)).toBe(revision);
      await git(dir, ["merge-base", "--is-ancestor", revision!, ref!]);
    }
    expect(
      await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    ).toBe(oldRefs.join("\n"));
    const threadsAfter = threadRows(dir);
    expect(threadsAfter.version).toEqual({
      value: String(REVIEW_THREAD_DB_SCHEMA_VERSION),
    });
    expect(threadsAfter.comments).toEqual(threadsBefore.comments);
    expect(threadsAfter.drafts).toEqual(threadsBefore.drafts);
    const snapshot = await snapshotReviewTree(dir);
    expect(await readStoredReview(dir)).toEqual(loaded);
    expect(await listReviews()).toMatchObject({ errors: [] });
    expect((await findReview(uuid))?.review.schemaVersion).toBe(6);
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
    // Importing replays the sealed history; it never writes to it.
    expect(seal).not.toHaveBeenCalled();
    expect(listPublications(dir, "document")).toHaveLength(1);
    expect(readLegacyArtifactImport(dir)).toMatchObject({ versions: 1 });
  });

  it("reports repair without mutations for a corrupt sealed document", async () => {
    const { dir, uuid, originalRecord } = await extract(fixture.name);
    await writeFile(
      path.join(dir, ".bundle/document/review-document.js"),
      'throw new Error("corrupt sealed document");',
    );
    const brokenRevision = await sealLegacyReviewCommit(
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
    const snapshot = await snapshotWithoutThreadDb(dir);
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
    expect(await snapshotWithoutThreadDb(dir)).toEqual(snapshot);
    expect(listPublications(dir, "document")).toEqual([]);
    expect(readLegacyArtifactImport(dir)).toBeNull();
  });
});

it("records an older JavaScript version without inventing its bytes", async () => {
  const { dir, originalRecord } = await extract("schema4-bug-report-dialog");
  const historical = originalRecord.presentedDocumentRevision as string;
  await writeFile(path.join(dir, "review.mdx"), "# Republished\n");
  const republished = await sealLegacyReviewCommit(
    dir,
    "Review publish candidate",
  );
  await writeFile(
    path.join(dir, "review.json"),
    JSON.stringify({
      ...originalRecord,
      presentedDocumentRevision: republished,
    }),
  );

  expect("error" in (await readStoredReview(dir))).toBe(false);

  const rows = listPublications(dir, "document");
  expect(rows.map((row) => row.publicationId)).toContain(historical);
  expect(
    rows.find((row) => row.publicationId === historical)?.artifactHash,
  ).toBeNull();
  expect(readLegacyArtifactImport(dir)).toMatchObject({ unavailable: 1 });
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
  const revision = await sealLegacyReviewCommit(
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
  const snapshot = await snapshotWithoutThreadDb(broken.dir);

  const listed = await listReviews();

  expect(listed.reviews).toHaveLength(1);
  expect(listed.reviews[0]?.review).toMatchObject({
    uuid: healthy.uuid,
    schemaVersion: 6,
  });
  expect(listed.errors).toHaveLength(1);
  expect(listed.errors[0]).toMatchObject({
    code: "REPAIR_REQUIRED",
    reviewUuid: broken.uuid,
  });
  expect(await snapshotWithoutThreadDb(broken.dir)).toEqual(snapshot);
});

it("preserves seeded prose and code threads and a prose draft", async () => {
  const { dir, originalRecord } = await extract("schema4-bug-report-dialog");
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
  const proseThread = ReviewCommentThreadRecordSchema.parse({
    threadId: "prose-thread",
    target,
    status: "open",
    messages: [
      {
        id: "prose-message",
        by: "Fixture reviewer",
        at: "2026-09-05T00:00:00.000Z",
        body: "Preserve prose",
        agentInput: false,
      },
    ],
  });
  const draft = ReviewCommentDraftThreadSchema.parse({
    thread: {
      ...proseThread,
      threadId: "draft-thread",
      messages: [
        {
          ...proseThread.messages[0],
          id: "draft-message",
          body: "Preserve draft",
        },
      ],
    },
    inputs: [
      {
        threadId: "draft-thread",
        messageId: "draft-message",
        target,
        body: "Preserve draft",
      },
    ],
  });
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
    // Seed the legacy layout without using a current-schema runtime writer.
    db.prepare(
      "INSERT INTO comments(thread_id, record_json) VALUES (?, ?)",
    ).run(proseThread.threadId, JSON.stringify(proseThread));
    db.prepare(
      "INSERT INTO comment_drafts(thread_id, record_json) VALUES (?, ?)",
    ).run(draft.thread.threadId, JSON.stringify(draft));
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
  expect(threadRows(dir)).toEqual({
    ...before,
    version: { value: String(REVIEW_THREAD_DB_SCHEMA_VERSION) },
  });
});
