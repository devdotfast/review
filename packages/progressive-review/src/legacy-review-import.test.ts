import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  jsonObject,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  readLegacyReviewGolden,
} from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  initLegacyReviewRepo,
  sealLegacyReviewCommit,
} from "./fixtures/legacy-reviews/legacy-review-git";
import {
  type LegacyImportAlreadyDone,
  LegacyImportBlocker,
  type LegacyImportPlan,
  commitLegacyReviewArtifactImport,
  importLegacyReviewArtifacts,
  legacyCompanionMapPublicationId,
  planLegacyReviewArtifactImport,
} from "./legacy-review-import";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "./review-artifact-store";
import {
  bundleReviewDocument,
  reviewDocumentBundleData,
  writeReviewDocumentBundle,
} from "./review-bundle";
import type { ReviewDocumentData } from "./review-document-data";
import {
  DISABLED_REVIEW_SOURCE_SESSION,
  createReviewDir,
  parseAnyStoredReviewRecord,
} from "./review-home";
import * as stateDb from "./review-state-db";
import {
  closeAllReviewStateDatabases,
  ensureReviewRegistration,
  insertPublicationInTransaction,
  listPublications,
  openReviewStateDb,
  putReviewRecord,
  readLegacyArtifactImport,
  readReviewRecord,
  resolveLegacyMapPublicationId,
  withReviewStateTransaction,
} from "./review-state-db";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome,
  writeLegacyDocument,
} from "./review-test-utils";
import {
  closeAllReviewThreadStores,
  migrateReviewThreadDb,
} from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import type { NormalizedSoftwareModel } from "./software-map-model";

const UUID = "33333333-3333-4333-8333-333333333333";
const BASE_COMMIT = "a".repeat(40);
const HEAD_COMMIT = "b".repeat(40);
const PUBLISH_CANDIDATE = "Review publish candidate";
const MAP_PUBLISH = "Publish Review software map";

const extractedHomes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  closeAllReviewThreadStores();
  closeAllReviewStateDatabases();
  await Promise.all(
    extractedHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  );
  await cleanupTempDirs();
});

interface LegacyReviewFixture {
  home: string;
  dir: string;
  record: JsonObject;
}

async function legacyReview(
  overrides: Partial<JsonObject> = {},
): Promise<LegacyReviewFixture> {
  const home = await reviewHome();
  const dir = path.join(home, "reviews", UUID);
  await mkdir(dir, { recursive: true });
  await initLegacyReviewRepo(dir);
  await writeFile(path.join(dir, "review.mdx"), "# Legacy\n", "utf8");
  const record: JsonObject = {
    schemaVersion: 4,
    uuid: UUID,
    repoKey: "repo",
    worktreePath: path.join(home, "worktree"),
    baseRef: "main",
    baseCommit: BASE_COMMIT,
    sourceCommit: HEAD_COMMIT,
    sourceIdentity: null,
    title: "Legacy review",
    sourceSession: DISABLED_REVIEW_SOURCE_SESSION,
    status: "awaiting-review",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastPublishedAt: null,
    ...overrides,
  };
  return { home, dir, record };
}

function documentData(title: string): ReviewDocumentData {
  return {
    format: "review-document/1",
    title,
    routePath: "/",
    sourcePath: "review.mdx",
    body: [
      {
        type: "element",
        tag: "h1",
        props: {},
        children: [{ type: "text", value: title }],
      },
    ],
    anchors: {},
    anchorContents: {},
    softwareModels: [],
  };
}

function emptyModel(): NormalizedSoftwareModel {
  return { elements: [], relationships: [], elementsByPath: new Map() };
}

async function writeDocumentV2(dir: string, title: string): Promise<void> {
  await writeReviewDocumentBundle(
    dir,
    bundleReviewDocument(documentData(title)),
  );
}

async function writeMapV2(
  dir: string,
  pins: { headCommit?: string; baseCommit?: string } = {},
): Promise<void> {
  await writeReviewSoftwareMapBundle(
    dir,
    bundleReviewSoftwareMap({
      head: emptyModel(),
      base: emptyModel(),
      headCommit: pins.headCommit ?? HEAD_COMMIT,
      baseCommit: pins.baseCommit ?? BASE_COMMIT,
    }),
  );
}

/** Seals the review tree with the record a Git-era publish would embed. */
interface SealInput {
  message: string;
  timestamp: number;
  document?: string | null;
  map?: string | null;
  /** The record this revision seals, when it differs from the fixture's. */
  record?: JsonObject;
}

async function seal(
  fixture: LegacyReviewFixture,
  input: SealInput,
): Promise<string> {
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify({
      ...(input.record ?? fixture.record),
      presentedDocumentRevision: input.document ?? null,
      presentedSoftwareMapRevision: input.map ?? null,
    }),
    "utf8",
  );
  return sealLegacyReviewCommit(fixture.dir, input.message, {
    timestamp: input.timestamp,
  });
}

/** Publishes the record the Review presents after its Git-era history. */
async function presentRecord(
  fixture: LegacyReviewFixture,
  pointers: { document: string | null; map: string | null },
): Promise<void> {
  const record: JsonObject = {
    ...fixture.record,
    presentedDocumentRevision: pointers.document,
    presentedSoftwareMapRevision: pointers.map,
  };
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify(record),
    "utf8",
  );
  putReviewRecord(fixture.dir, record, fixture.home);
}

/** Replans a review the way Task 9 will: from the record the database holds. */
async function planImport(
  fixture: LegacyReviewFixture,
): Promise<LegacyImportPlan | LegacyImportAlreadyDone> {
  const stored = jsonObject(readReviewRecord(fixture.dir, fixture.home));
  if (!stored) throw new Error("The fixture has no stored record.");
  return planLegacyReviewArtifactImport({
    reviewDir: fixture.dir,
    record: parseAnyStoredReviewRecord(stored),
    original: stored,
    home: fixture.home,
  });
}

function requirePlan(
  result: LegacyImportPlan | LegacyImportAlreadyDone,
): LegacyImportPlan {
  if ("imported" in result)
    throw new Error("Expected a plan, not an already-imported marker.");
  return result;
}

/** Simulates an import that lost its marker and some of its rows. */
function forgetImportRows(
  fixture: LegacyReviewFixture,
  publicationIds: readonly string[],
): void {
  const db = openReviewStateDb(fixture.home);
  db.prepare("DELETE FROM legacy_artifact_imports WHERE review_id = ?").run(
    UUID,
  );
  for (const publicationId of publicationIds)
    db.prepare(
      "DELETE FROM publications WHERE review_id = ? AND publication_id = ?",
    ).run(UUID, publicationId);
}

it("imports every publish candidate and its published map as rows", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "v1");
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await writeMapV2(fixture.dir);
  const map = await seal(fixture, {
    message: MAP_PUBLISH,
    timestamp: 1_760_000_100,
    document: first,
  });
  await writeDocumentV2(fixture.dir, "v2");
  const second = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_200,
    document: first,
    map,
  });
  await writeDocumentV2(fixture.dir, "v3");
  const third = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_300,
    document: second,
    map,
  });
  await presentRecord(fixture, { document: third, map });

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result.imported).toBe(true);
  expect(result.versions).toBe(3);
  expect(result.unavailable).toBe(0);
  const documents = listPublications(fixture.dir, "document", fixture.home);
  expect(documents.map((row) => row.publicationId)).toEqual([
    third,
    second,
    first,
  ]);
  expect(documents.map((row) => row.seq)).toEqual([4, 3, 1]);
  expect(documents.map((row) => row.operation)).toEqual([
    "publish",
    "publish",
    "publish",
  ]);
  const maps = listPublications(fixture.dir, "map", fixture.home);
  expect(maps).toHaveLength(1);
  expect(maps[0]).toMatchObject({
    publicationId: map,
    seq: 2,
    operation: "map-publish",
    legacyCommit: map,
  });
  expect(documents[1]?.record).toMatchObject({
    pairedMapPublicationId: map,
    createdAt: "2025-10-09T08:56:40.000Z",
    title: "Legacy review",
    titleSource: "stored",
    legacy: { commit: second, layout: "document-v2-json" },
  });
  expect(documents[2]?.record).toMatchObject({
    pairedMapPublicationId: null,
    previousPublicationId: null,
  });
  expect(documents[0]?.record).toMatchObject({
    previousPublicationId: second,
  });
  for (const row of [...documents, ...maps])
    expect(row.artifactHash).toMatch(/^[0-9a-f]{64}$/);

  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: third,
    presentedSoftwareMapRevision: map,
    title: "Legacy review",
  });
  expect(readLegacyArtifactImport(fixture.dir, fixture.home)).toMatchObject({
    versions: 3,
    unavailable: 0,
    sourceHead: third,
    legacyRemovedAt: null,
  });
  expect(result.record.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
  expect(legacyCompanionMapPublicationId(UUID, map)).toMatch(/^[0-9a-f]{40}$/);
});

it("evaluates the presented JavaScript bundle and leaves older ones unavailable", async () => {
  const fixture = await legacyReview();
  await writeLegacyDocument(fixture.dir);
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await writeLegacyDocument(fixture.dir);
  const second = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_100,
    document: first,
  });
  await presentRecord(fixture, { document: second, map: null });

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result).toMatchObject({ versions: 2, unavailable: 1 });
  const documents = listPublications(fixture.dir, "document", fixture.home);
  expect(documents.map((row) => row.publicationId)).toEqual([second, first]);
  expect(documents[1]).toMatchObject({ artifactHash: null });
  expect(documents[1]?.record).toMatchObject({
    artifact: { state: "unavailable", reason: "legacy-v1-javascript" },
    legacy: { layout: "document-v1-js" },
  });
  const presented = documents[0];
  expect(presented?.record).toMatchObject({
    artifact: { state: "stored" },
    legacy: { layout: "document-v1-js" },
  });
  const artifact = await readReviewDocumentArtifact(
    fixture.dir,
    presented?.artifactHash ?? "",
  );
  expect(artifact?.json).toContain("Exact sealed title");
});

it("gives a tutorial commit's map a companion publication ID", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "Tutorial");
  await writeMapV2(fixture.dir);
  const only = await seal(fixture, {
    message: "Materialize bundled tutorial Review",
    timestamp: 1_760_000_000,
  });
  await presentRecord(fixture, { document: only, map: only });

  await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  const companion = legacyCompanionMapPublicationId(UUID, only);
  const documents = listPublications(fixture.dir, "document", fixture.home);
  expect(documents).toHaveLength(1);
  expect(documents[0]).toMatchObject({
    publicationId: only,
    seq: 2,
    operation: "tutorial",
    legacyCommit: only,
  });
  expect(documents[0]?.record).toMatchObject({
    pairedMapPublicationId: companion,
  });
  const maps = listPublications(fixture.dir, "map", fixture.home);
  expect(maps).toHaveLength(1);
  expect(maps[0]).toMatchObject({
    publicationId: companion,
    seq: 1,
    operation: "tutorial",
    legacyCommit: only,
  });
  expect(resolveLegacyMapPublicationId(fixture.dir, only, fixture.home)).toBe(
    companion,
  );
  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    presentedDocumentRevision: only,
    presentedSoftwareMapRevision: companion,
  });
});

it("imports a schema-2 presentation that legitimately has no software map", async () => {
  const fixture = await legacyReview({ schemaVersion: 2 });
  delete fixture.record.presentedDocumentRevision;
  delete fixture.record.presentedSoftwareMapRevision;
  await writeDocumentV2(fixture.dir, "Schema two");
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify({ ...fixture.record, presentedRevision: null }),
    "utf8",
  );
  const only = await sealLegacyReviewCommit(fixture.dir, PUBLISH_CANDIDATE, {
    timestamp: 1_760_000_000,
  });
  const record: JsonObject = { ...fixture.record, presentedRevision: only };
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify(record),
    "utf8",
  );
  putReviewRecord(fixture.dir, record, fixture.home);

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result.versions).toBe(1);
  expect(listPublications(fixture.dir, "map", fixture.home)).toEqual([]);
  expect(
    listPublications(fixture.dir, "document", fixture.home)[0],
  ).toMatchObject({ publicationId: only });
  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: only,
    presentedSoftwareMapRevision: null,
  });
});

it("leaves the private Git history untouched", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "v1");
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await writeMapV2(fixture.dir);
  const map = await seal(fixture, {
    message: MAP_PUBLISH,
    timestamp: 1_760_000_100,
    document: first,
  });
  await presentRecord(fixture, { document: first, map });
  const before = await reviewVcs.log(fixture.dir);

  await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(await reviewVcs.log(fixture.dir)).toEqual(before);
});

it("writes nothing when a row insert fails and replays cleanly afterwards", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "v1");
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await writeDocumentV2(fixture.dir, "v2");
  const second = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_100,
    document: first,
  });
  await presentRecord(fixture, { document: second, map: null });
  const stored = readReviewRecord(fixture.dir, fixture.home);
  const insert = vi
    .spyOn(stateDb, "insertPublicationInTransaction")
    .mockImplementationOnce(stateDb.insertPublicationInTransaction)
    .mockImplementationOnce(() => {
      throw new Error("simulated insert failure");
    });

  await expect(
    importLegacyReviewArtifacts({ reviewDir: fixture.dir, home: fixture.home }),
  ).rejects.toThrow("simulated insert failure");

  expect(insert).toHaveBeenCalledTimes(2);
  expect(listPublications(fixture.dir, "document", fixture.home)).toEqual([]);
  expect(readLegacyArtifactImport(fixture.dir, fixture.home)).toBeNull();
  expect(readReviewRecord(fixture.dir, fixture.home)).toEqual(stored);
  const artifacts = await readdir(
    path.join(fixture.dir, "artifacts", "documents"),
  );
  expect(artifacts).toHaveLength(2);
  insert.mockRestore();

  const retried = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(retried.imported).toBe(true);
  const rows = listPublications(fixture.dir, "document", fixture.home);
  expect(rows.map((row) => row.publicationId)).toEqual([second, first]);
  expect(
    await readdir(path.join(fixture.dir, "artifacts", "documents")),
  ).toEqual(artifacts);
});

it("skips rows it already committed and refuses to replace a different one", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "v1");
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await writeDocumentV2(fixture.dir, "v2");
  const second = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_100,
    document: first,
  });
  await presentRecord(fixture, { document: second, map: null });
  await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });
  // An import that landed its older row and then lost everything else: the
  // replay must recognize that row as its own instead of re-inserting it.
  forgetImportRows(fixture, [second]);

  const replay = requirePlan(await planImport(fixture));

  expect(replay.publications.map((row) => row.publicationId)).toEqual([second]);
  expect(replay.versions).toBe(2);
  await commitLegacyReviewArtifactImport(fixture.dir, replay, fixture.home);
  expect(
    listPublications(fixture.dir, "document", fixture.home).map(
      (row) => row.publicationId,
    ),
  ).toEqual([second, first]);
  expect(readLegacyArtifactImport(fixture.dir, fixture.home)).toMatchObject({
    versions: 2,
  });

  forgetImportRows(fixture, [second]);
  openReviewStateDb(fixture.home)
    .prepare(
      "UPDATE publications SET record_json = json_set(record_json, '$.title', 'Rewritten') WHERE publication_id = ?",
    )
    .run(first);

  await expect(planImport(fixture)).rejects.toThrow(LegacyImportBlocker);
});

it("imports the database record when review.json is an older mirror", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "v1");
  const only = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await presentRecord(fixture, { document: only, map: null });
  putReviewRecord(
    fixture.dir,
    {
      ...fixture.record,
      title: "Renamed after the mirror",
      presentedDocumentRevision: only,
      presentedSoftwareMapRevision: null,
    },
    fixture.home,
  );

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result.record.title).toBe("Renamed after the mirror");
  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    title: "Renamed after the mirror",
    schemaVersion: REVIEW_SCHEMA_VERSION,
  });
  expect(
    JSON.parse(await readFile(path.join(fixture.dir, "review.json"), "utf8")),
  ).toMatchObject({
    title: "Renamed after the mirror",
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: only,
  });
});

it("rebuilds an unconvertible presented document from its editable sources", async () => {
  const home = await reviewHome();
  const worktreePath = await gitRepository();
  const commit = execFileSync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const created = await createReviewDir({
    uuid: UUID,
    reviewsHomePath: home,
    worktreePath,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
  });
  const fixture: LegacyReviewFixture = {
    home,
    dir: created.dir,
    record: {
      ...(jsonObject(readReviewRecord(created.dir, home)) ?? {}),
      schemaVersion: 4,
    },
  };
  await writeLegacyDocument(created.dir, {
    code: "export default null;\n",
  });
  const only = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_000,
  });
  await presentRecord(fixture, { document: only, map: null });
  const stored = jsonObject(readReviewRecord(created.dir, home));
  if (!stored) throw new Error("The fixture has no stored record.");

  const plan = requirePlan(
    await planLegacyReviewArtifactImport({
      reviewDir: created.dir,
      record: parseAnyStoredReviewRecord(stored),
      original: stored,
      home,
      activeDocumentFallback: "editable-source",
    }),
  );

  expect(plan.sourceFallback).toEqual({ document: true, map: false });
  expect(plan.warnings[0]).toBe(
    "Sealed document conversion failed: Review document bundle has no " +
      "runtime import.. Using editable review.mdx/data.ts; reconcile " +
      "unpublished edits without changing the Review's meaning. Validation " +
      "does not prove semantic equivalence.",
  );
  const record = await commitLegacyReviewArtifactImport(
    created.dir,
    plan,
    home,
  );

  const documents = listPublications(created.dir, "document", home);
  expect(documents).toHaveLength(2);
  expect(documents[1]).toMatchObject({
    publicationId: only,
    seq: 1,
    artifactHash: null,
  });
  expect(documents[0]).toMatchObject({
    seq: 2,
    operation: "repair",
    previousPublicationId: only,
    legacyCommit: only,
  });
  expect(documents[0]?.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  expect(record.presentedDocumentRevision).toBe(documents[0]?.publicationId);
  expect(plan.unavailable).toBe(1);

  // Replaying the fallback must mint the same ID: a row's identity cannot
  // depend on when the import ran, or the replay would insert a second copy
  // of the repair row at a sequence the first one already holds.
  forgetImportRows(fixture, [only]);
  const replay = requirePlan(
    await planLegacyReviewArtifactImport({
      reviewDir: created.dir,
      record: parseAnyStoredReviewRecord(stored),
      original: stored,
      home,
      activeDocumentFallback: "editable-source",
    }),
  );
  // The repair row is re-minted under its committed ID, recognized as this
  // import's own and dropped; only the deleted row is left to insert.
  expect(replay.activeDocumentId).toBe(documents[0]?.publicationId);
  expect(replay.publications.map((row) => row.publicationId)).toEqual([only]);
}, 30_000);

it("keeps a schema-2 companion map as a map publication", async () => {
  const fixture = await legacyReview({ schemaVersion: 2 });
  delete fixture.record.presentedDocumentRevision;
  delete fixture.record.presentedSoftwareMapRevision;
  await writeDocumentV2(fixture.dir, "Schema two");
  await writeMapV2(fixture.dir);
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify({ ...fixture.record, presentedRevision: null }),
    "utf8",
  );
  const only = await sealLegacyReviewCommit(fixture.dir, PUBLISH_CANDIDATE, {
    timestamp: 1_760_000_000,
  });
  const record: JsonObject = { ...fixture.record, presentedRevision: only };
  await writeFile(
    path.join(fixture.dir, "review.json"),
    JSON.stringify(record),
    "utf8",
  );
  putReviewRecord(fixture.dir, record, fixture.home);

  await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  const companion = legacyCompanionMapPublicationId(UUID, only);
  expect(
    listPublications(fixture.dir, "document", fixture.home)[0],
  ).toMatchObject({ publicationId: only, operation: "publish" });
  expect(listPublications(fixture.dir, "map", fixture.home)[0]).toMatchObject({
    publicationId: companion,
    operation: "map-publish",
    legacyCommit: only,
  });
});

it("skips a historical map whose pins cannot be recovered", async () => {
  const fixture = await legacyReview();
  const unpinned = await seal(fixture, {
    message: MAP_PUBLISH,
    timestamp: 1_760_000_000,
    record: { ...fixture.record, sourceCommit: null },
  });
  await writeDocumentV2(fixture.dir, "v1");
  const first = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_100,
    map: unpinned,
  });
  await writeDocumentV2(fixture.dir, "v2");
  const second = await seal(fixture, {
    message: PUBLISH_CANDIDATE,
    timestamp: 1_760_000_200,
    document: first,
  });
  await presentRecord(fixture, { document: second, map: null });

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result.versions).toBe(2);
  expect(result.warnings).toEqual([
    `Software map revision ${unpinned} has no commit pins to record; it is ` +
      "not imported and the documents presented beside it keep no paired map.",
  ]);
  expect(listPublications(fixture.dir, "map", fixture.home)).toEqual([]);
  const documents = listPublications(fixture.dir, "document", fixture.home);
  expect(documents.map((row) => row.publicationId)).toEqual([second, first]);
  expect(documents[1]?.record).toMatchObject({ pairedMapPublicationId: null });
});

it("marks a review whose pointer already answers to a row as imported", async () => {
  const fixture = await legacyReview();
  const publicationId = "d".repeat(40);
  ensureReviewRegistration(fixture.dir, fixture.home);
  withReviewStateTransaction(fixture.home, (tx) =>
    insertPublicationInTransaction(tx, fixture.dir, {
      publicationId,
      kind: "document",
      record: { kind: "document", createdAt: "2026-01-01T00:00:00.000Z" },
      createdAt: "2026-01-01T00:00:00.000Z",
      operation: "publish",
      artifactHash: null,
      previousPublicationId: null,
    }),
  );
  await presentRecord(fixture, { document: publicationId, map: null });

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result).toMatchObject({ imported: true, versions: 0, unavailable: 0 });
  expect(readLegacyArtifactImport(fixture.dir, fixture.home)).toMatchObject({
    versions: 0,
    unavailable: 0,
    sourceHead: null,
  });
  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: publicationId,
    presentedSoftwareMapRevision: null,
  });
  expect(
    listPublications(fixture.dir, "document", fixture.home).map(
      (row) => row.publicationId,
    ),
  ).toEqual([publicationId]);
});

it("marks a review that never presented a document as imported", async () => {
  const fixture = await legacyReview();
  await writeDocumentV2(fixture.dir, "never presented");
  await sealLegacyReviewCommit(fixture.dir, PUBLISH_CANDIDATE, {
    timestamp: 1_760_000_000,
  });
  await presentRecord(fixture, { document: null, map: null });

  const result = await importLegacyReviewArtifacts({
    reviewDir: fixture.dir,
    home: fixture.home,
  });

  expect(result).toMatchObject({ imported: true, versions: 0 });
  expect(readLegacyArtifactImport(fixture.dir, fixture.home)).toMatchObject({
    versions: 0,
    unavailable: 0,
    sourceHead: null,
  });
  expect(listPublications(fixture.dir, "document", fixture.home)).toEqual([]);
  expect(readReviewRecord(fixture.dir, fixture.home)).toMatchObject({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
  });
});

describe.each(listLegacyReviewFixtures())(
  "legacy fixture $name",
  (metadata) => {
    it("imports its private history into publication rows", async () => {
      const extracted = await extractLegacyReviewFixture(metadata.name);
      extractedHomes.push(extracted.home);
      vi.stubEnv("DEV_REVIEW_HOME", extracted.home);
      // Schema migration upgrades the thread database before the artifact
      // import runs; these fixtures ship the version that predates it.
      await migrateReviewThreadDb(path.join(extracted.dir, "review.mdx"), {
        preserveLegacyQuestions: true,
      });
      closeAllReviewThreadStores();

      const result = await importLegacyReviewArtifacts({
        reviewDir: extracted.dir,
        home: extracted.home,
      });

      expect(result).toMatchObject({ imported: true, unavailable: 0 });
      const documents = listPublications(
        extracted.dir,
        "document",
        extracted.home,
      );
      const presented = documents[0];
      expect(presented?.publicationId).toBe(
        extracted.originalRecord.presentedDocumentRevision,
      );
      expect(presented?.record).toMatchObject({
        legacy: { commit: presented?.publicationId },
      });
      const document = await readReviewDocumentArtifact(
        extracted.dir,
        presented?.artifactHash ?? "",
      );
      expect(document && reviewDocumentBundleData(document)).toEqual(
        await readLegacyReviewGolden(metadata.name, "document"),
      );
      const maps = listPublications(extracted.dir, "map", extracted.home);
      expect(maps.length > 0).toBe(metadata.hasMap);
      if (!metadata.hasMap) return;
      const presentedMap = maps[0];
      expect(presentedMap?.legacyCommit).toBe(
        extracted.originalRecord.presentedSoftwareMapRevision,
      );
      expect(
        await readReviewSoftwareMapArtifact(
          extracted.dir,
          presentedMap?.artifactHash ?? "",
        ),
      ).toEqual(await readLegacyReviewGolden(metadata.name, "map"));
      expect(readReviewRecord(extracted.dir, extracted.home)).toMatchObject({
        presentedDocumentRevision: presented?.publicationId,
        presentedSoftwareMapRevision: presentedMap?.publicationId,
      });
    }, 30_000);
  },
);
