import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotReviewTree } from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "./review-artifact-store";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  reviewDocumentBundleData,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  createReviewDir,
  materializeReviewRevision,
  parseStoredReviewRecord,
  readStoredReview,
  sealReviewCandidate,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import {
  type ReviewPublicationRecord,
  parsePublicationRecord,
} from "./review-publication-record";
import {
  deleteReviewState,
  listPublications,
  putReviewRecord as putReviewRecordFromDb,
  readLegacyArtifactImport,
  readPublication,
  readReviewRecord as readReviewRecordFromDb,
} from "./review-state-db";
import {
  cleanupTempDirs,
  gitRepository,
  tempDir,
  writeLegacyDocument,
} from "./review-test-utils";
import { reviewVcs } from "./review-vcs";
import {
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import {
  defineSoftwareMap,
  softwareModelDataSchema,
} from "./software-map-model";
import {
  migrateStoredReview,
  migrateStoredReviewData,
} from "./stored-review-migration";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe("migrateStoredReviewData", () => {
  it("rejects a malformed legacy session alias without changing the review", async () => {
    const { created } = await storedReview();
    const recordPath = path.join(created.dir, "review.json");
    const malformed = `${JSON.stringify({
      ...created.review,
      schemaVersion: 3,
      agentSession: 42,
    })}\n`;
    await writeFile(recordPath, malformed);
    const before = await snapshotMigrationFiles(created.dir);

    await expect(
      migrateStoredReview({ reviewDir: created.dir }),
    ).rejects.toThrow(/agentSession/);

    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    await expect(readFile(recordPath, "utf8")).resolves.toBe(malformed);
  });

  it("does not replace live files when the artifact import fails", async () => {
    const { created } = await storedReview();
    await writeLegacyDocument(created.dir);
    const revision = await sealReviewCandidate(created.dir, "Legacy document");
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: revision,
      }),
    );
    const names = ["review.json", ".bundle", ".git"];
    const before = await Promise.all(
      names.map(async (name) => (await stat(path.join(created.dir, name))).ino),
    );
    vi.spyOn(reviewVcs, "materialize").mockRejectedValue(
      new Error("candidate disk full"),
    );

    await expect(
      migrateStoredReview({ reviewDir: created.dir }),
    ).rejects.toThrow("candidate disk full");
    expect(listPublications(created.dir, "document")).toEqual([]);
    expect(readLegacyArtifactImport(created.dir)).toBeNull();

    expect(
      await Promise.all(
        names.map(
          async (name) => (await stat(path.join(created.dir, name))).ino,
        ),
      ),
    ).toEqual(before);
  });

  it("imports independent current document and map revisions as their own rows", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    await writeLegacyDocument(created.dir);
    const sourceFiles = ["review.mdx", "data.ts", "software-map.ts"];
    for (const name of sourceFiles) {
      await writeFile(
        path.join(created.dir, name),
        `Sealed document ${name}\n`,
      );
    }
    const documentRevision = await sealReviewCandidate(
      created.dir,
      "Legacy document only",
    );
    await writeLegacySoftwareMapBundle(created.dir, {
      headCommit: sourceCommit,
      baseCommit: sourceCommit,
    });
    for (const name of sourceFiles) {
      await writeFile(path.join(created.dir, name), `Sealed map ${name}\n`);
    }
    const mapRevision = await sealReviewCandidate(
      created.dir,
      "Legacy independent map",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        baseRef: "unpublished-branch",
        presentedDocumentRevision: documentRevision,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    for (const name of sourceFiles) {
      await writeFile(path.join(created.dir, name), `Unpublished ${name}\n`);
    }
    const seal = vi.spyOn(reviewVcs, "seal");
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toEqual([]);
    // Importing replays the sealed history; it never adds to it.
    expect(seal).not.toHaveBeenCalled();
    const current = await readReviewRecord(created.dir);
    expect(current.baseRef).toBe("unpublished-branch");
    // Each sealed commit keeps its identity as its publication ID.
    expect(current.presentedDocumentRevision).toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).toBe(mapRevision);
    expect(
      listPublications(created.dir, "document").map((row) => row.legacyCommit),
    ).toEqual([documentRevision]);
    expect(
      listPublications(created.dir, "map").map((row) => row.legacyCommit),
    ).toEqual([mapRevision]);
    expect((await presentedDocumentArtifact(created.dir)).title).toBe("Sealed");
    await expectConvertedSoftwareMap(created.dir);
    // The private history and the unpublished working files are untouched.
    const sealedMap = await materializedRevision(created.dir, mapRevision);
    for (const name of sourceFiles) {
      expect(await readFile(path.join(sealedMap, name), "utf8")).toBe(
        `Sealed map ${name}\n`,
      );
      expect(await readFile(path.join(created.dir, name), "utf8")).toBe(
        `Unpublished ${name}\n`,
      );
    }
  });

  it("preserves an independent JSON map while converting the schema-3 document", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    const model = defineSoftwareMap({
      systems: { service: { label: "Service" } },
    });
    await writeReviewSoftwareMapBundle(
      created.dir,
      bundleReviewSoftwareMap({
        head: model,
        base: model,
        headCommit: sourceCommit,
        baseCommit: sourceCommit,
      }),
    );
    const mapRevision = await sealReviewCandidate(created.dir, "JSON map");
    await writeLegacyDocument(created.dir);
    const documentRevision = await sealReviewCandidate(
      created.dir,
      "Legacy document",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 3,
        presentedDocumentRevision: documentRevision,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toEqual([]);
    const current = await readReviewRecord(created.dir);
    expect(current.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
    expect(current.presentedDocumentRevision).toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).toBe(mapRevision);
    expect((await presentedDocumentArtifact(created.dir)).title).toBe("Sealed");
    expect((await presentedMapArtifact(created.dir)).headCommit).toBe(
      sourceCommit,
    );
  });

  it("blocks a broken presented map without promoting a prepared document", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    await writeLegacyDocument(created.dir);
    await writeLegacySoftwareMapBundle(created.dir, {
      headCommit: sourceCommit,
      baseCommit: sourceCommit,
    });
    await rm(path.join(created.dir, ".bundle/software-map/base-map.js"));
    const revision = await sealReviewCandidate(created.dir, "Missing base map");
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: revision,
        presentedSoftwareMapRevision: revision,
      }),
    );
    const before = await snapshotMigrationFiles(created.dir);
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("software map");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    expect(listPublications(created.dir, "document")).toEqual([]);
    expect(listPublications(created.dir, "map")).toEqual([]);
    expect(readLegacyArtifactImport(created.dir)).toBeNull();
  });

  it("rejects a concurrent lifecycle change without restoring over it", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir);
    const revision = await sealReviewCandidate(created.dir, "Legacy document");
    const original = {
      ...created.review,
      schemaVersion: 4,
      presentedDocumentRevision: revision,
    };
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify(original),
    );
    // The database is authoritative for the live record: a concurrent
    // lifecycle change lands there, not in the review.json mirror.
    const materialize = reviewVcs.materialize.bind(reviewVcs);
    vi.spyOn(reviewVcs, "materialize").mockImplementation(async (...args) => {
      await materialize(...args);
      putReviewRecordFromDb(created.dir, { ...original, status: "accepted" });
    });
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("changed while preparing");
    expect(readReviewRecordFromDb(created.dir)).toEqual({
      ...original,
      status: "accepted",
    });
    expect(await reviewVcs.resolve(created.dir, "HEAD")).toBe(revision);
  });

  it("only upgrades an unpresented schema-4 draft and keeps its candidate bytes", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir, {
      code: "invalid unpresented candidate",
    });
    const candidate = await readFile(
      path.join(created.dir, ".bundle/document/review-document.js"),
      "utf8",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({ ...created.review, schemaVersion: 4 }),
    );
    await migrateStoredReviewData({ reviewHome });
    expect(await readReviewRecord(created.dir)).toEqual({
      ...created.review,
      schemaVersion: REVIEW_SCHEMA_VERSION,
    });
    expect(
      await readFile(
        path.join(created.dir, ".bundle/document/review-document.js"),
        "utf8",
      ),
    ).toBe(candidate);
  });
  it.each(["awaiting-review", "accepted", "rejected"])(
    "imports only the sealed current schema-4 %s document without authoring inputs",
    async (status) => {
      const { created, reviewHome } = await storedReview();
      await writeLegacyDocument(created.dir);
      await rm(path.join(created.dir, "review.mdx"));
      await rm(path.join(created.dir, "data.ts"));
      const revision = await sealReviewCandidate(
        created.dir,
        "Exact legacy document",
      );
      const original = {
        ...created.review,
        schemaVersion: 4,
        status,
        presentedDocumentRevision: revision,
        lastPublishedAt: "2026-09-01T00:00:00.000Z",
        dismissedAt: "2026-09-02T00:00:00.000Z",
      };
      await writeFile(
        path.join(created.dir, "review.json"),
        JSON.stringify(original),
      );
      const blockers: string[] = [];
      await migrateStoredReviewData({
        reviewHome,
        onBlocker: (message) => blockers.push(message),
      });
      expect(blockers).toEqual([]);
      const current = await readReviewRecord(created.dir);
      expect(current).toEqual({
        ...original,
        schemaVersion: REVIEW_SCHEMA_VERSION,
      });
      expect(await presentedDocumentArtifact(created.dir)).toMatchObject({
        format: "review-document/1",
        body: [
          {
            type: "element",
            tag: "h1",
            children: [{ type: "text", value: "Exact sealed title" }],
          },
        ],
      });
      // The sealed JavaScript is converted into the store, not over the
      // Review's own files: the deleted authoring inputs stay deleted.
      await expect(
        readFile(path.join(created.dir, "review.mdx")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const before = await snapshotMigrationFiles(created.dir);
      await migrateStoredReviewData({ reviewHome });
      expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
      expect(
        await readFile(
          path.join(
            await materializedRevision(created.dir, revision),
            ".bundle/document/review-document.js",
          ),
          "utf8",
        ),
      ).toContain("Exact sealed title");
    },
  );

  it("preserves every record and candidate byte and private ref on a failed import", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir);
    const revision = await sealReviewCandidate(created.dir, "Legacy document");
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: revision,
      }),
    );
    const before = await snapshotMigrationFiles(created.dir);
    const materialize = reviewVcs.materialize.bind(reviewVcs);
    vi.spyOn(reviewVcs, "materialize").mockImplementation(async (...args) => {
      await materialize(...args);
      throw new Error("injected materialization failure");
    });
    const blockers: string[] = [];
    const result = await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(result).toMatchObject({
      droppedReviews: 0,
      importedVersions: 0,
      unavailableVersions: 0,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("injected materialization failure");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    expect(listPublications(created.dir, "document")).toEqual([]);
  });

  it("leaves a failed sealed conversion unchanged even when sources would compile", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir, {
      code: 'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    });
    const revision = await sealReviewCandidate(
      created.dir,
      "Broken sealed document",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: revision,
      }),
    );
    const before = await snapshotMigrationFiles(created.dir);
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("broken sealed document");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });
  it("preserves unsupported reviews as explicit blockers", async () => {
    const reviewHome = await tempDir("review-migration-");
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const reviewDir = path.join(reviewHome, "reviews", uuid);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "review.json"),
      `${JSON.stringify({ schemaVersion: 1, uuid })}\n`,
    );

    const blockers: string[] = [];
    await expect(
      migrateStoredReviewData({
        reviewHome,
        onBlocker: (message) => blockers.push(message),
      }),
    ).resolves.toMatchObject({ droppedReviews: 0, documents: 0 });
    expect(blockers).toHaveLength(1);
    await expect(
      readFile(path.join(reviewDir, "review.json")),
    ).resolves.toBeDefined();
  });

  it("preserves a legacy draft and legacy thread files", async () => {
    const reviewHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    const current = parseStoredReviewRecord(
      parseJsonText(
        await readFile(path.join(created.dir, "review.json"), "utf8"),
      ),
    );
    const {
      presentedDocumentRevision: _documentRevision,
      presentedSoftwareMapRevision: _softwareMapRevision,
      ...legacy
    } = current;
    // A schema-2 draft predates the database; simulate that with no row.
    deleteReviewState(created.dir);
    await writeFile(
      path.join(created.dir, "review.json"),
      `${JSON.stringify({
        ...legacy,
        schemaVersion: 2,
        presentedRevision: null,
      })}\n`,
    );
    await writeFile(path.join(created.dir, "comments.json"), '{"old":{}}\n');
    await writeFile(path.join(created.dir, "questions.json"), '{"old":{}}\n');

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
      droppedComments: 0,
      droppedQuestions: 0,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain(`"schemaVersion": ${REVIEW_SCHEMA_VERSION}`);
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"sourceSession": "disabled:review"');
    await expect(
      readFile(path.join(created.dir, "comments.json")),
    ).resolves.toEqual(Buffer.from('{"old":{}}\n'));
  });

  it("recovers a schema-2 software map from its sealed JavaScript bundle", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    await writeLegacyDocument(created.dir);
    await writeLegacySoftwareMapBundle(created.dir, {
      baseCommit: sourceCommit,
      headCommit: sourceCommit,
    });
    const legacyRevision = await sealSchema2Candidate(
      created.dir,
      "Legacy Review publication",
    );
    await rm(path.join(created.dir, ".bundle", "software-map"), {
      recursive: true,
      force: true,
    });

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(legacyRevision);
    // A schema-2 revision presents document and map together, so the map row
    // takes a companion ID rather than the commit the document row holds.
    expect(migrated.presentedSoftwareMapRevision).not.toBeNull();
    expect(migrated.presentedSoftwareMapRevision).not.toBe(legacyRevision);
    await expectConvertedSoftwareMap(created.dir);
  });

  it("preserves a genuine flat schema-2 embedded map and its sealed pins", async () => {
    const { created } = await flatSchema2Review("valid");
    const current = parseJsonText(
      await readFile(path.join(created.dir, "review.json"), "utf8"),
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...jsonObject(current),
        sourceCommit: "f".repeat(40),
        baseCommit: "e".repeat(40),
      }),
    );
    const result = await migrateStoredReview({ reviewDir: created.dir });
    expect(result.record.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
    expect(result.record.presentedSoftwareMapRevision).not.toBeNull();
    const bundle = await presentedMapArtifact(created.dir);
    expect(
      softwareModelDataSchema.parse({
        elements: jsonObject(parseJsonText(bundle.headJson))?.elements,
        relationships: jsonObject(parseJsonText(bundle.headJson))
          ?.relationships,
      }).elements,
    ).toEqual(
      defineSoftwareMap({ systems: { service: { label: "Head" } } }).elements,
    );
    expect(
      softwareModelDataSchema.parse({
        elements: jsonObject(parseJsonText(bundle.baseJson))?.elements,
        relationships: jsonObject(parseJsonText(bundle.baseJson))
          ?.relationships,
      }).elements,
    ).toEqual(
      defineSoftwareMap({ systems: { service: { label: "Base" } } }).elements,
    );
    // The map is pinned by the record sealed beside it, while the live
    // record keeps the pins it carried into the migration.
    expect(bundle.headCommit).toBe(created.review.sourceCommit);
    expect(bundle.baseCommit).toBe(created.review.baseCommit);
    expect(result.record.sourceCommit).toBe("f".repeat(40));
    expect(result.record.baseCommit).toBe("e".repeat(40));
  });

  it("preserves the original flat schema-2 review when its embedded map pair is invalid", async () => {
    const { created } = await flatSchema2Review("invalid");
    const before = await snapshotMigrationFiles(created.dir);
    await expect(
      migrateStoredReview({ reviewDir: created.dir }),
    ).rejects.toThrow("embedded software map");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("does not invent an embedded repository map from inline flat schema-2 models", async () => {
    const { created } = await flatSchema2Review("absent");
    const result = await migrateStoredReview({ reviewDir: created.dir });
    expect(result.record.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
    expect(result.record.presentedSoftwareMapRevision).toBeNull();
    expect(listPublications(created.dir, "map")).toEqual([]);
    expect(
      (await presentedDocumentArtifact(created.dir)).softwareModels,
    ).toHaveLength(2);
  });

  it("migrates a schema-2 review with missing legacy maps without a blocker", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir);
    const legacyRevision = await sealSchema2Candidate(
      created.dir,
      "Legacy Review publication without a map",
    );
    const blockers: string[] = [];

    await expect(
      migrateStoredReviewData({
        reviewHome,
        onBlocker: (message) => blockers.push(message),
      }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    expect(blockers).toEqual([]);
    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(legacyRevision);
    expect(migrated.presentedSoftwareMapRevision).toBeNull();
    expect(listPublications(created.dir, "map")).toEqual([]);
  });

  it("imports a schema-4 legacy map independently and skips artifact work on a repeated sweep", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    const documentRevision = await sealReviewCandidate(
      created.dir,
      "Published Review document",
    );
    await writeLegacySoftwareMapBundle(created.dir, {
      baseCommit: sourceCommit,
      headCommit: sourceCommit,
    });
    const legacyMapRevision = await sealReviewCandidate(
      created.dir,
      "Published legacy software map",
    );
    await rm(path.join(created.dir, ".bundle", "software-map"), {
      recursive: true,
      force: true,
    });
    await writeCurrentRecord(created.dir, {
      schemaVersion: 4,
      presentedDocumentRevision: documentRevision,
      presentedSoftwareMapRevision: legacyMapRevision,
    });

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(documentRevision);
    expect(migrated.presentedSoftwareMapRevision).toBe(legacyMapRevision);
    await expectConvertedSoftwareMap(created.dir);
    const migratedMapRevision = migrated.presentedSoftwareMapRevision;
    const before = await snapshotReviewTree(created.dir);
    const materialize = vi.spyOn(reviewVcs, "materialize");
    const seal = vi.spyOn(reviewVcs, "seal");
    const legacyRepos = path.join(reviewHome, "repos");
    await mkdir(legacyRepos);
    await writeFile(path.join(legacyRepos, "legacy-cache"), "retired");
    const repeated = await migrateStoredReviewData({ reviewHome });
    expect(repeated).toMatchObject({
      documents: 1,
      upgradedThreadDatabases: 0,
      droppedReviews: 0,
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(await snapshotReviewTree(created.dir)).toEqual(before);
    await expect(stat(legacyRepos)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readReviewRecord(created.dir)).presentedSoftwareMapRevision,
    ).toBe(migratedMapRevision);
  });

  it("leaves a current valid JSON map revision unchanged", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    const documentRevision = await sealReviewCandidate(
      created.dir,
      "Published Review document",
    );
    const model = defineSoftwareMap({
      systems: { service: { label: "Service" } },
    });
    await writeReviewSoftwareMapBundle(
      created.dir,
      bundleReviewSoftwareMap({
        head: model,
        base: model,
        headCommit: sourceCommit,
        baseCommit: sourceCommit,
      }),
    );
    const mapRevision = await sealReviewCandidate(
      created.dir,
      "Published JSON software map",
    );
    await writeCurrentRecord(created.dir, {
      presentedDocumentRevision: documentRevision,
      presentedSoftwareMapRevision: mapRevision,
    });

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(documentRevision);
    expect(migrated.presentedSoftwareMapRevision).toBe(mapRevision);
  });

  it("preserves current draft authoring with removed code peek fields", async () => {
    const reviewHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    await writeFile(
      path.join(created.dir, "data.ts"),
      [
        'import { defineAnchors } from "virtual:progressive-review-authoring";',
        "export const anchors = defineAnchors({",
        "  oldSymbol: {",
        '    title: "Old symbol",',
        '    peek: { symbol: "resolveThing" },',
        "  },",
        "  oldDeclaration: {",
        '    title: "Old declaration",',
        '    peek: { declarationId: "src/thing.ts::resolveThing" },',
        "  },",
        "});",
      ].join("\n"),
    );

    const log: string[] = [];
    await expect(
      migrateStoredReviewData({
        reviewHome,
        log: (message) => log.push(message),
      }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
    });
    expect(log).not.toContain(expect.stringContaining("Dropped Review"));
    await expect(
      readFile(path.join(created.dir, "review.json")),
    ).resolves.toBeDefined();
  });

  it("keeps range Reviews that only mention removed field names", async () => {
    const reviewHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    await writeFile(
      path.join(created.dir, "data.ts"),
      [
        'import { defineAnchors } from "virtual:progressive-review-authoring";',
        "// symbol: and declarationId: are removed.",
        'const compatibility = "symbol: declarationId:";',
        "export const anchors = defineAnchors({",
        "  range: {",
        '    title: "Range",',
        '    peek: { file: "src/thing.ts", fromLine: 1, toLine: 2 },',
        "  },",
        "});",
        "void compatibility;",
      ].join("\n"),
    );

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain(created.review.uuid);
  });
});

describe("migrateStoredReview", () => {
  it("upgrades one schema-4 review in place and is a byte-level no-op on repeat", async () => {
    const { created } = await storedReview();
    await writeLegacyDocument(created.dir);
    const revision = await sealReviewCandidate(created.dir, "Legacy document");
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        status: "accepted",
        dismissedAt: "2026-01-01T00:00:00Z",
        presentedDocumentRevision: revision,
      }),
    );

    const first = await migrateStoredReview({ reviewDir: created.dir });

    expect(first.migrated).toBe(true);
    expect(first.threadDbError).toBeUndefined();
    const record = await readReviewRecord(created.dir);
    expect(record).toMatchObject({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      uuid: created.review.uuid,
      status: "accepted",
      dismissedAt: "2026-01-01T00:00:00Z",
      baseCommit: created.review.baseCommit,
      sourceCommit: created.review.sourceCommit,
    });
    expect(record.presentedDocumentRevision).toBe(revision);
    expect(first).toMatchObject({
      importedVersions: 1,
      unavailableVersions: 0,
    });
    expect(first.record).toEqual(record);
    expect((await presentedDocumentArtifact(created.dir)).title).toBe("Sealed");

    const before = await snapshotMigrationFiles(created.dir);
    const materialize = vi.spyOn(reviewVcs, "materialize");
    const seal = vi.spyOn(reviewVcs, "seal");
    const second = await migrateStoredReview({ reviewDir: created.dir });
    expect(second.migrated).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("leaves a review untouched when its sealed document is broken", async () => {
    const { created } = await storedReview();
    await writeLegacyDocument(created.dir, {
      code: 'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    });
    const revision = await sealReviewCandidate(created.dir, "Broken document");
    const legacy = JSON.stringify({
      ...created.review,
      schemaVersion: 4,
      presentedDocumentRevision: revision,
    });
    await writeFile(path.join(created.dir, "review.json"), legacy);
    const before = await snapshotMigrationFiles(created.dir);

    await expect(
      migrateStoredReview({ reviewDir: created.dir }),
    ).rejects.toThrow("broken sealed document");

    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    expect(await readFile(path.join(created.dir, "review.json"), "utf8")).toBe(
      legacy,
    );
  });
});

async function flatSchema2Review(maps: "valid" | "invalid" | "absent") {
  const fixture = await storedReview();
  const bundleDir = path.join(fixture.created.dir, ".bundle");
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir);
  await writeFile(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(
    path.join(bundleDir, "review-document.js"),
    `
import { createActiveReviewDocument, defineSoftwareModel, jsx } from "review-doc-runtime";
const head = defineSoftwareModel({ systems: { service: { label: "Head" } } });
const base = defineSoftwareModel({ systems: { service: { label: "Base" } } });
export default createActiveReviewDocument({ title: "Flat", routePath: "/", filePath: "review.mdx", modelNames: [], models: {},
repoSoftwareMap: ${maps === "absent" ? "null" : "head"}, baseSoftwareMap: ${maps === "valid" ? "base" : "null"},
Component: () => jsx("p", { children: "Sealed flat document" }), isDefault: true });
`,
  );
  await sealSchema2Candidate(fixture.created.dir, "Flat schema-2 publication");
  return fixture;
}

async function storedReview() {
  const reviewHome = await tempDir("review-migration-");
  const sourceRoot = await gitRepository();
  const sourceCommit = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const created = await createReviewDir({
    reviewsHomePath: reviewHome,
    worktreePath: sourceRoot,
    baseRef: "main",
    baseCommit: sourceCommit,
    sourceCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  await writeReviewDocumentBundle(
    created.dir,
    bundleReviewDocument({
      format: "review-document/1",
      title: "JSON",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }),
  );
  // Every caller overwrites review.json with a legacy record next; a legacy
  // record predates the database, so its read must fall back to the file
  // rather than resolve the current-schema row `createReviewDir` just wrote.
  deleteReviewState(created.dir);
  return { created, reviewHome, sourceCommit };
}

/** Every authored and sealed byte of a Review. `artifacts/` is excluded: the
 * store is content-addressed and immutable, so a refused import legitimately
 * leaves unreferenced bytes behind that nothing points at. */
async function snapshotMigrationFiles(
  dir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (name === ".build" || name === ".git/objects" || name === "artifacts")
        continue;
      if (entry.isDirectory()) await visit(name);
      else
        files[name] = (await readFile(path.join(dir, name))).toString("base64");
    }
  }
  await visit("");
  return files;
}

async function writeLegacySoftwareMapBundle(
  reviewDir: string,
  commits: { headCommit: string; baseCommit: string },
): Promise<void> {
  const mapDir = path.join(reviewDir, ".bundle", "software-map");
  const model = defineSoftwareMap({
    systems: { service: { label: "Service" } },
  });
  const moduleSource = [
    `const elements = Object.freeze(${JSON.stringify(model.elements)});`,
    `const relationships = Object.freeze(${JSON.stringify(model.relationships)});`,
    "const elementsByPath = new Map(elements.map((element) => [element.path, element]));",
    "export default Object.freeze({ elements, elementsByPath, relationships });",
    "",
  ].join("\n");
  await mkdir(mapDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(mapDir, "head-map.js"), moduleSource),
    writeFile(path.join(mapDir, "base-map.js"), moduleSource),
    writeFile(
      path.join(mapDir, "manifest.json"),
      `${JSON.stringify({ version: 1, ...commits }, null, 2)}\n`,
    ),
  ]);
}

async function writeSchema2Record(
  reviewDir: string,
  presentedRevision: string | null,
): Promise<void> {
  const current = jsonObject(
    parseJsonText(await readFile(path.join(reviewDir, "review.json"), "utf8")),
  )!;
  const {
    presentedDocumentRevision: _documentRevision,
    presentedSoftwareMapRevision: _mapRevision,
    presentedRevision: _presentedRevision,
    schemaVersion: _schemaVersion,
    ...legacy
  } = current;
  await writeFile(
    path.join(reviewDir, "review.json"),
    `${JSON.stringify({
      ...legacy,
      schemaVersion: 2,
      presentedRevision,
    })}\n`,
  );
}

/** A real schema-2 publication sealed its own schema-2 record, so the import
 * reads the sealed record's version — not the live one — when it decides
 * whether a presentation may legitimately carry no software map. */
async function sealSchema2Candidate(
  reviewDir: string,
  message: string,
): Promise<string> {
  await writeSchema2Record(reviewDir, null);
  const revision = await sealReviewCandidate(reviewDir, message);
  await writeSchema2Record(reviewDir, revision);
  return revision;
}

/** The document bytes the presented publication row serves. */
async function presentedDocumentArtifact(reviewDir: string) {
  const record = presentedPublicationRecord(reviewDir, "document");
  if (record.artifact.state !== "stored")
    throw new Error("The presented document artifact is unavailable.");
  const bundle = await readReviewDocumentArtifact(
    reviewDir,
    record.artifact.hash,
  );
  if (!bundle) throw new Error("The presented document artifact is missing.");
  return reviewDocumentBundleData(bundle);
}

/** The software map bytes the presented publication row serves. */
async function presentedMapArtifact(reviewDir: string) {
  const record = presentedPublicationRecord(reviewDir, "map");
  if (record.artifact.state !== "stored")
    throw new Error("The presented map artifact is unavailable.");
  const bundle = await readReviewSoftwareMapArtifact(
    reviewDir,
    record.artifact.hash,
  );
  if (!bundle) throw new Error("The presented map artifact is missing.");
  return bundle;
}

function presentedPublicationRecord(
  reviewDir: string,
  kind: "document" | "map",
): ReviewPublicationRecord {
  const record = parseStoredReviewRecord(readReviewRecordFromDb(reviewDir));
  const publicationId =
    kind === "document"
      ? record.presentedDocumentRevision
      : record.presentedSoftwareMapRevision;
  if (!publicationId) throw new Error(`No presented ${kind} publication.`);
  const row = readPublication(reviewDir, publicationId, kind);
  if (!row) throw new Error(`No ${kind} row for ${publicationId}.`);
  return parsePublicationRecord(row.record);
}

async function writeCurrentRecord(
  reviewDir: string,
  revisions: {
    schemaVersion?: 4;
    presentedDocumentRevision: string;
    presentedSoftwareMapRevision: string;
  },
): Promise<void> {
  const current = await readReviewRecord(reviewDir);
  await writeFile(
    path.join(reviewDir, "review.json"),
    `${JSON.stringify({ ...current, ...revisions })}\n`,
  );
}

async function readReviewRecord(reviewDir: string) {
  return parseStoredReviewRecord(
    parseJsonText(await readFile(path.join(reviewDir, "review.json"), "utf8")),
  );
}

async function materializedRevision(
  reviewDir: string,
  revision: string,
): Promise<string> {
  const destination = path.join(reviewDir, ".build", `test-${revision}`);
  await materializeReviewRevision(reviewDir, revision, destination);
  return destination;
}

/** The presented map row serves the converted JSON software map. */
async function expectConvertedSoftwareMap(reviewDir: string): Promise<void> {
  const bundle = await presentedMapArtifact(reviewDir);
  expect(jsonObject(parseJsonText(bundle.headJson))).toMatchObject({
    format: "software-map/1",
    elements: [{ path: "service" }],
  });
  expect(jsonObject(parseJsonText(bundle.baseJson))).toMatchObject({
    format: "software-map/1",
  });
}

describe("legacy artifact import on first read", () => {
  it("imports every publish candidate as a publication row", async () => {
    const { created } = await storedReview();
    await writeLegacyDocument(created.dir);
    const first = await sealReviewCandidate(
      created.dir,
      "Review publish candidate",
    );
    await writeLegacyDocument(created.dir, {
      code: `import { createActiveReviewDocument, jsx } from "review-doc-runtime";
export default createActiveReviewDocument({ title: "Second", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Second" }), isDefault: true });`,
    });
    const second = await sealReviewCandidate(
      created.dir,
      "Review publish candidate",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: second,
      }),
    );

    const loaded = await readStoredReview(created.dir);

    expect("error" in loaded).toBe(false);
    expect(
      listPublications(created.dir, "document").map((row) => row.publicationId),
    ).toEqual([second, first]);
    // Only the presented JavaScript bundle can be evaluated; an older v1
    // version is recorded as a row whose bytes are unavailable.
    expect(readLegacyArtifactImport(created.dir)).toMatchObject({
      versions: 2,
      unavailable: 1,
    });
    expect(
      listPublications(created.dir, "document").map((row) => row.artifactHash),
    ).toEqual([expect.any(String), null]);
    expect(await readReviewRecord(created.dir)).toMatchObject({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      presentedDocumentRevision: second,
    });
  });
});
