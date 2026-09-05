import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  createReviewDir,
  materializeReviewRevision,
  parseStoredReviewRecord,
  sealReviewCandidate,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { reviewVcs } from "./review-vcs";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";
import {
  migrateStoredReview,
  migrateStoredReviewData,
} from "./stored-review-migration";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("migrateStoredReviewData", () => {
  it.each([false, true])(
    "preserves a competing candidate writer after migration rollback=%s",
    async (fail) => {
      const { created, reviewHome } = await storedReview();
      await writeLegacyDocument(created.dir);
      const revision = await sealReviewCandidate(
        created.dir,
        "Legacy document",
      );
      await writeFile(
        path.join(created.dir, "review.json"),
        JSON.stringify({
          ...created.review,
          schemaVersion: 4,
          presentedDocumentRevision: revision,
        }),
      );
      const entered = deferred();
      const release = deferred();
      const seal = reviewVcs.seal.bind(reviewVcs);
      vi.spyOn(reviewVcs, "seal").mockImplementation(async (dir, message) => {
        if (dir !== created.dir) {
          entered.resolve();
          await release.promise;
          if (fail) throw new Error("injected transaction failure");
        }
        return seal(dir, message);
      });
      const blockers: string[] = [];
      const migration = migrateStoredReviewData({
        reviewHome,
        onBlocker: (message) => blockers.push(message),
      });
      await entered.promise;
      let writerFinished = false;
      const writing = withReviewMutationLock(created.dir, async () => {
        await writeReviewDocumentBundle(
          created.dir,
          bundleReviewDocument({
            format: "review-document/1",
            title: "Concurrent writer",
            routePath: "/",
            sourcePath: "review.mdx",
            body: [],
            anchors: {},
            anchorContents: {},
            softwareModels: [],
          }),
        );
        const head = await sealReviewCandidate(created.dir, "Competing writer");
        writerFinished = true;
        return head;
      });
      expect(writerFinished).toBe(false);
      release.resolve();
      await migration;
      const writerHead = await writing;
      expect(blockers).toHaveLength(fail ? 1 : 0);
      expect(await reviewVcs.resolve(created.dir, "HEAD")).toBe(writerHead);
      expect(
        JSON.parse(
          await readFile(
            path.join(created.dir, ".bundle/document/review-document.json"),
            "utf8",
          ),
        ).title,
      ).toBe("Concurrent writer");
      const current = JSON.parse(
        await readFile(path.join(created.dir, "review.json"), "utf8"),
      );
      expect(current.schemaVersion).toBe(fail ? 4 : 5);
      expect(current.presentedDocumentRevision === revision).toBe(fail);
    },
  );
  it("converts independent current document/map revisions and embeds the final map pin", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
    await writeLegacyDocument(created.dir);
    const documentRevision = await sealReviewCandidate(
      created.dir,
      "Legacy document only",
    );
    await writeLegacySoftwareMapBundle(created.dir, {
      headCommit: sourceCommit,
      baseCommit: sourceCommit,
    });
    const mapRevision = await sealReviewCandidate(
      created.dir,
      "Legacy independent map",
    );
    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify({
        ...created.review,
        schemaVersion: 4,
        presentedDocumentRevision: documentRevision,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    await writeFile(
      path.join(created.dir, "review.mdx"),
      "Unpublished edits must stay here\n",
    );
    const originalRecord = await readFile(
      path.join(created.dir, "review.json"),
      "utf8",
    );
    const seal = reviewVcs.seal.bind(reviewVcs);
    const sealing = vi
      .spyOn(reviewVcs, "seal")
      .mockImplementation(async (...args) => {
        expect(
          await readFile(path.join(created.dir, "review.json"), "utf8"),
        ).toBe(originalRecord);
        return seal(...args);
      });
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toEqual([]);
    expect(sealing).toHaveBeenCalledTimes(2);
    const current = await readReviewRecord(created.dir);
    expect(current.presentedDocumentRevision).not.toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).not.toBe(mapRevision);
    expect(current.presentedDocumentRevision).not.toBe(
      current.presentedSoftwareMapRevision,
    );
    const sealed = await materializedRevision(
      created.dir,
      current.presentedDocumentRevision!,
    );
    expect((await readReviewRecord(sealed)).presentedSoftwareMapRevision).toBe(
      current.presentedSoftwareMapRevision,
    );
    await expectJsonMapRevision(
      created.dir,
      current.presentedSoftwareMapRevision!,
    );
    expect(await readFile(path.join(created.dir, "review.mdx"), "utf8")).toBe(
      "Unpublished edits must stay here\n",
    );
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
    expect(current.schemaVersion).toBe(5);
    expect(current.presentedDocumentRevision).not.toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).toBe(mapRevision);
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
    const materialize = reviewVcs.materialize.bind(reviewVcs);
    vi.spyOn(reviewVcs, "materialize").mockImplementation(async (...args) => {
      await materialize(...args);
      await writeFile(
        path.join(created.dir, "review.json"),
        JSON.stringify({ ...original, status: "accepted" }),
      );
    });
    const blockers: string[] = [];
    await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("changed while preparing");
    expect(
      JSON.parse(await readFile(path.join(created.dir, "review.json"), "utf8")),
    ).toEqual({ ...original, status: "accepted" });
    expect(await reviewVcs.resolve(created.dir, "HEAD")).toBe(revision);
  });

  it("only upgrades an unpresented schema-4 draft and keeps its candidate bytes", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir, "invalid unpresented candidate");
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
      schemaVersion: 5,
    });
    expect(
      await readFile(
        path.join(created.dir, ".bundle/document/review-document.js"),
        "utf8",
      ),
    ).toBe(candidate);
  });
  it.each(["awaiting-review", "accepted", "rejected"])(
    "converts only the sealed current schema-4 %s document without authoring inputs",
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
      expect(current).toMatchObject({
        ...original,
        schemaVersion: 5,
        presentedDocumentRevision: expect.any(String),
      });
      expect(current.presentedDocumentRevision).not.toBe(revision);
      const document = JSON.parse(
        await readFile(
          path.join(created.dir, ".bundle/document/review-document.json"),
          "utf8",
        ),
      );
      expect(document).toMatchObject({
        format: "review-document/1",
        body: [
          {
            type: "element",
            tag: "h1",
            children: [{ type: "text", value: "Exact sealed title" }],
          },
        ],
      });
      await expect(
        readFile(path.join(created.dir, ".bundle/document/review-document.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(created.dir, "review.mdx")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const before = await readFile(
        path.join(created.dir, "review.json"),
        "utf8",
      );
      await migrateStoredReviewData({ reviewHome });
      expect(
        await readFile(path.join(created.dir, "review.json"), "utf8"),
      ).toBe(before);
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

  it("preserves every record and candidate byte and private ref on failed sealing", async () => {
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
    const seal = reviewVcs.seal.bind(reviewVcs);
    vi.spyOn(reviewVcs, "seal").mockImplementation(async (dir, message) => {
      await seal(dir, message);
      throw new Error("injected seal failure");
    });
    const blockers: string[] = [];
    const result = await migrateStoredReviewData({
      reviewHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(result.droppedReviews).toBe(0);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("injected seal failure");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("leaves a failed sealed conversion unchanged even when sources would compile", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(
      created.dir,
      'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    );
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
    const reviewHome = await tempDir();
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
    const reviewHome = await tempDir();
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
    ).resolves.toContain('"schemaVersion": 5');
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
    const legacyRevision = await sealReviewCandidate(
      created.dir,
      "Legacy Review publication",
    );
    await rm(path.join(created.dir, ".bundle", "software-map"), {
      recursive: true,
      force: true,
    });
    await writeSchema2Record(created.dir, legacyRevision);

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).not.toBeNull();
    expect(migrated.presentedSoftwareMapRevision).not.toBeNull();
    await expectJsonMapRevision(
      created.dir,
      migrated.presentedSoftwareMapRevision!,
    );
  });

  it("migrates a schema-2 review with missing legacy maps without a blocker", async () => {
    const { created, reviewHome } = await storedReview();
    await writeLegacyDocument(created.dir);
    const legacyRevision = await sealReviewCandidate(
      created.dir,
      "Legacy Review publication without a map",
    );
    await writeSchema2Record(created.dir, legacyRevision);
    const blockers: string[] = [];

    await expect(
      migrateStoredReviewData({
        reviewHome,
        onBlocker: (message) => blockers.push(message),
      }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    expect(blockers).toEqual([]);
    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).not.toBeNull();
    expect(migrated.presentedSoftwareMapRevision).toBeNull();
  });

  it("converts a current legacy map independently from its document revision", async () => {
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
      presentedDocumentRevision: documentRevision,
      presentedSoftwareMapRevision: legacyMapRevision,
    });

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ documents: 1, droppedReviews: 0 });

    const migrated = await readReviewRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(documentRevision);
    expect(migrated.presentedSoftwareMapRevision).not.toBe(legacyMapRevision);
    expect(migrated.presentedSoftwareMapRevision).not.toBe(documentRevision);
    await expectJsonMapRevision(
      created.dir,
      migrated.presentedSoftwareMapRevision!,
    );
    const migratedMapRevision = migrated.presentedSoftwareMapRevision;
    await migrateStoredReviewData({ reviewHome });
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
    const reviewHome = await tempDir();
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
    const reviewHome = await tempDir();
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
      schemaVersion: 5,
      uuid: created.review.uuid,
      status: "accepted",
      dismissedAt: "2026-01-01T00:00:00Z",
      baseCommit: created.review.baseCommit,
      sourceCommit: created.review.sourceCommit,
    });
    expect(record.presentedDocumentRevision).not.toBe(revision);
    expect(first.record).toEqual(record);
    const materialized = await tempDir();
    await materializeReviewRevision(
      created.dir,
      record.presentedDocumentRevision!,
      materialized,
    );
    expect(
      (await readReviewDocumentBundle(materialized, "/"))?.document.title,
    ).toBe("Sealed");

    const before = await snapshotMigrationFiles(created.dir);
    const second = await migrateStoredReview({ reviewDir: created.dir });
    expect(second.migrated).toBe(false);
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("leaves a review untouched when its sealed document is broken", async () => {
    const { created } = await storedReview();
    await writeLegacyDocument(
      created.dir,
      'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    );
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

async function storedReview() {
  const reviewHome = await tempDir();
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
  return { created, reviewHome, sourceCommit };
}

async function writeLegacyDocument(
  dir: string,
  code = `import { createActiveReviewDocument, jsx } from "review-doc-runtime";
export default createActiveReviewDocument({ title: "Sealed", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Exact sealed title" }), isDefault: true });`,
) {
  const target = path.join(dir, ".bundle/document");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(path.join(target, "review-document.js"), code);
}

async function snapshotMigrationFiles(
  dir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (name === ".build" || name === ".git/objects") continue;
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
  presentedRevision: string,
): Promise<void> {
  const current = await readReviewRecord(reviewDir);
  const {
    presentedDocumentRevision: _documentRevision,
    presentedSoftwareMapRevision: _mapRevision,
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

async function writeCurrentRecord(
  reviewDir: string,
  revisions: {
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

async function expectJsonMapRevision(
  reviewDir: string,
  revision: string,
): Promise<void> {
  const mapRevisionDir = await materializedRevision(reviewDir, revision);
  const mapDir = path.join(mapRevisionDir, ".bundle", "software-map");
  await expect(
    readdir(mapDir).then((entries) => entries.sort()),
  ).resolves.toEqual(["base-map.json", "head-map.json", "manifest.json"]);
  await expect(
    readFile(path.join(mapDir, "manifest.json"), "utf8").then((source) =>
      JSON.parse(source),
    ),
  ).resolves.toMatchObject({ version: 2 });
  await expect(
    readFile(path.join(mapDir, "head-map.json"), "utf8").then((source) =>
      JSON.parse(source),
    ),
  ).resolves.toMatchObject({
    format: "software-map/1",
    elements: [{ path: "service" }],
  });
}

async function gitRepository(): Promise<string> {
  const root = await tempDir("review-migration-source-");
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "review@example.test",
  ]);
  execFileSync("git", ["-C", root, "config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], {
    stdio: "ignore",
  });
  return root;
}

async function tempDir(prefix = "review-migration-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
