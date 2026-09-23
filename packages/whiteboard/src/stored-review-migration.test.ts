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

import { jsonObject, parseJsonText } from "@dev.fast/whiteboard-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotWhiteboardTree } from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  bundleWhiteboardSoftwareMap,
  readWhiteboardSoftwareMapBundle,
  writeWhiteboardSoftwareMapBundle,
} from "./software-map-bundle";
import {
  defineSoftwareMap,
  softwareModelDataSchema,
} from "./software-map-model";
import {
  migrateStoredWhiteboard,
  migrateStoredWhiteboardData,
} from "./stored-review-migration";
import {
  bundleWhiteboardDocument,
  readWhiteboardDocumentBundle,
  whiteboardDocumentBundleData,
  writeWhiteboardDocumentBundle,
} from "./whiteboard-bundle";
import {
  createWhiteboardDir,
  materializeWhiteboardRevision,
  parseStoredWhiteboardRecord,
  sealWhiteboardCandidate,
} from "./whiteboard-home";
import { withWhiteboardMutationLock } from "./whiteboard-mutation-lock";
import {
  cleanupTempDirs,
  gitRepository,
  tempDir,
  writeLegacyDocument,
} from "./whiteboard-test-utils";
import { whiteboardVcs } from "./whiteboard-vcs";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe("migrateStoredWhiteboardData", () => {
  it("rejects a malformed legacy session alias without changing the review", async () => {
    const { created } = await storedWhiteboard();
    const recordPath = path.join(created.dir, "review.json");

    const malformed = `${JSON.stringify({
      ...created.review,
      schemaVersion: 3,
      agentSession: 42,
    })}\n`;

    await writeFile(recordPath, malformed);
    const before = await snapshotMigrationFiles(created.dir);

    await expect(
      migrateStoredWhiteboard({ whiteboardDir: created.dir }),
    ).rejects.toThrow(/agentSession/);

    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    await expect(readFile(recordPath, "utf8")).resolves.toBe(malformed);
  });

  it("does not replace live files when sealing the isolated candidate fails", async () => {
    const { created } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);

    const revision = await sealWhiteboardCandidate(
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
    const names = ["review.json", ".bundle", ".git"];

    const before = await Promise.all(
      names.map(async (name) => (await stat(path.join(created.dir, name))).ino),
    );

    vi.spyOn(whiteboardVcs, "seal").mockRejectedValue(
      new Error("candidate disk full"),
    );

    await expect(
      migrateStoredWhiteboard({ whiteboardDir: created.dir }),
    ).rejects.toThrow("candidate disk full");

    expect(
      await Promise.all(
        names.map(
          async (name) => (await stat(path.join(created.dir, name))).ino,
        ),
      ),
    ).toEqual(before);
  });

  it.each([false, true])(
    "preserves a competing candidate writer after migration rollback=%s",
    async (fail) => {
      const { created, whiteboardHome } = await storedWhiteboard();
      await writeLegacyDocument(created.dir);

      const revision = await sealWhiteboardCandidate(
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
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const seal = whiteboardVcs.seal.bind(whiteboardVcs);
      vi.spyOn(whiteboardVcs, "seal").mockImplementation(
        async (dir, message) => {
          if (dir !== created.dir) {
            entered.resolve();
            await release.promise;

            if (fail) throw new Error("injected transaction failure");
          }

          return seal(dir, message);
        },
      );
      const blockers: string[] = [];

      const migration = migrateStoredWhiteboardData({
        whiteboardHome,
        onBlocker: (message) => blockers.push(message),
      });

      await entered.promise;
      let writerFinished = false;

      const writing = withWhiteboardMutationLock(created.dir, async () => {
        await writeWhiteboardDocumentBundle(
          created.dir,
          bundleWhiteboardDocument({
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

        const head = await sealWhiteboardCandidate(
          created.dir,
          "Competing writer",
        );

        writerFinished = true;

        return head;
      });

      expect(writerFinished).toBe(false);
      release.resolve();
      await migration;
      const writerHead = await writing;
      expect(blockers).toHaveLength(fail ? 1 : 0);
      expect(await whiteboardVcs.resolve(created.dir, "HEAD")).toBe(writerHead);
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
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);
    const sourceFiles = ["review.mdx", "data.ts", "software-map.ts"];

    for (const name of sourceFiles) {
      await writeFile(
        path.join(created.dir, name),
        `Sealed document ${name}\n`,
      );
    }

    const documentRevision = await sealWhiteboardCandidate(
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

    const mapRevision = await sealWhiteboardCandidate(
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

    const originalRecord = await readFile(
      path.join(created.dir, "review.json"),
      "utf8",
    );

    const seal = whiteboardVcs.seal.bind(whiteboardVcs);

    const sealing = vi
      .spyOn(whiteboardVcs, "seal")
      .mockImplementation(async (...args) => {
        expect(
          await readFile(path.join(created.dir, "review.json"), "utf8"),
        ).toBe(originalRecord);

        return seal(...args);
      });

    const blockers: string[] = [];
    await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toEqual([]);
    expect(sealing).toHaveBeenCalledTimes(2);
    const current = await readWhiteboardRecord(created.dir);
    expect(current.baseRef).toBe("unpublished-branch");
    expect(current.presentedDocumentRevision).not.toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).not.toBe(mapRevision);
    expect(current.presentedDocumentRevision).not.toBe(
      current.presentedSoftwareMapRevision,
    );

    const sealed = await materializedRevision(
      created.dir,
      current.presentedDocumentRevision!,
    );

    expect(
      (await readWhiteboardRecord(sealed)).presentedSoftwareMapRevision,
    ).toBe(current.presentedSoftwareMapRevision);
    expect((await readWhiteboardRecord(sealed)).baseRef).toBe(
      created.review.baseRef,
    );

    const sealedMap = await materializedRevision(
      created.dir,
      current.presentedSoftwareMapRevision!,
    );

    for (const name of sourceFiles) {
      expect(await readFile(path.join(sealed, name), "utf8")).toBe(
        `Sealed document ${name}\n`,
      );
      expect(await readFile(path.join(sealedMap, name), "utf8")).toBe(
        `Sealed map ${name}\n`,
      );
      expect(await readFile(path.join(created.dir, name), "utf8")).toBe(
        `Unpublished ${name}\n`,
      );
    }

    await expectJsonMapRevision(
      created.dir,
      current.presentedSoftwareMapRevision!,
    );
  });

  it("preserves an independent JSON map while converting the schema-3 document", async () => {
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();

    const model = defineSoftwareMap({
      systems: { service: { label: "Service" } },
    });

    await writeWhiteboardSoftwareMapBundle(
      created.dir,
      bundleWhiteboardSoftwareMap({
        head: model,
        base: model,
        headCommit: sourceCommit,
        baseCommit: sourceCommit,
      }),
    );
    const mapRevision = await sealWhiteboardCandidate(created.dir, "JSON map");
    await writeLegacyDocument(created.dir);

    const documentRevision = await sealWhiteboardCandidate(
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
    await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toEqual([]);
    const current = await readWhiteboardRecord(created.dir);
    expect(current.schemaVersion).toBe(5);
    expect(current.presentedDocumentRevision).not.toBe(documentRevision);
    expect(current.presentedSoftwareMapRevision).toBe(mapRevision);
  });

  it("blocks a broken presented map without promoting a prepared document", async () => {
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);
    await writeLegacySoftwareMapBundle(created.dir, {
      headCommit: sourceCommit,
      baseCommit: sourceCommit,
    });
    await rm(path.join(created.dir, ".bundle/software-map/base-map.js"));

    const revision = await sealWhiteboardCandidate(
      created.dir,
      "Missing base map",
    );

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
    await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("software map");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("rejects a concurrent lifecycle change without restoring over it", async () => {
    const { created, whiteboardHome } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);

    const revision = await sealWhiteboardCandidate(
      created.dir,
      "Legacy document",
    );

    const original = {
      ...created.review,
      schemaVersion: 4,
      presentedDocumentRevision: revision,
    };

    await writeFile(
      path.join(created.dir, "review.json"),
      JSON.stringify(original),
    );
    const materialize = whiteboardVcs.materialize.bind(whiteboardVcs);
    vi.spyOn(whiteboardVcs, "materialize").mockImplementation(
      async (...args) => {
        await materialize(...args);
        await writeFile(
          path.join(created.dir, "review.json"),
          JSON.stringify({ ...original, status: "accepted" }),
        );
      },
    );
    const blockers: string[] = [];
    await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("changed while preparing");
    expect(
      JSON.parse(await readFile(path.join(created.dir, "review.json"), "utf8")),
    ).toEqual({ ...original, status: "accepted" });
    expect(await whiteboardVcs.resolve(created.dir, "HEAD")).toBe(revision);
  });

  it("only upgrades an unpresented schema-4 draft and keeps its candidate bytes", async () => {
    const { created, whiteboardHome } = await storedWhiteboard();
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
    await migrateStoredWhiteboardData({ whiteboardHome });
    expect(await readWhiteboardRecord(created.dir)).toEqual({
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
      const { created, whiteboardHome } = await storedWhiteboard();
      await writeLegacyDocument(created.dir);
      await rm(path.join(created.dir, "review.mdx"));
      await rm(path.join(created.dir, "data.ts"));

      const revision = await sealWhiteboardCandidate(
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
      await migrateStoredWhiteboardData({
        whiteboardHome,
        onBlocker: (message) => blockers.push(message),
      });
      expect(blockers).toEqual([]);
      const current = await readWhiteboardRecord(created.dir);
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

      await migrateStoredWhiteboardData({ whiteboardHome });
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
    const { created, whiteboardHome } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);

    const revision = await sealWhiteboardCandidate(
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
    const before = await snapshotMigrationFiles(created.dir);
    const seal = whiteboardVcs.seal.bind(whiteboardVcs);
    vi.spyOn(whiteboardVcs, "seal").mockImplementation(async (dir, message) => {
      await seal(dir, message);
      throw new Error("injected seal failure");
    });
    const blockers: string[] = [];

    const result = await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });

    expect(result.droppedWhiteboards).toBe(0);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("injected seal failure");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("leaves a failed sealed conversion unchanged even when sources would compile", async () => {
    const { created, whiteboardHome } = await storedWhiteboard();
    await writeLegacyDocument(created.dir, {
      code: 'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    });

    const revision = await sealWhiteboardCandidate(
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
    await migrateStoredWhiteboardData({
      whiteboardHome,
      onBlocker: (message) => blockers.push(message),
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("broken sealed document");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });
  it("preserves unsupported reviews as explicit blockers", async () => {
    const whiteboardHome = await tempDir("review-migration-");
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const whiteboardDir = path.join(whiteboardHome, "reviews", uuid);
    await mkdir(whiteboardDir, { recursive: true });
    await writeFile(
      path.join(whiteboardDir, "review.json"),
      `${JSON.stringify({ schemaVersion: 1, uuid })}\n`,
    );

    const blockers: string[] = [];
    await expect(
      migrateStoredWhiteboardData({
        whiteboardHome,
        onBlocker: (message) => blockers.push(message),
      }),
    ).resolves.toMatchObject({ droppedWhiteboards: 0, documents: 0 });
    expect(blockers).toHaveLength(1);
    await expect(
      readFile(path.join(whiteboardDir, "review.json")),
    ).resolves.toBeDefined();
  });

  it("preserves a legacy draft and untouched legacy files", async () => {
    const whiteboardHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();

    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    const created = await createWhiteboardDir({
      reviewsHomePath: whiteboardHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });

    const current = parseStoredWhiteboardRecord(
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
      migrateStoredWhiteboardData({ whiteboardHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekWhiteboards: 0,
      droppedWhiteboards: 0,
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
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);
    await writeLegacySoftwareMapBundle(created.dir, {
      baseCommit: sourceCommit,
      headCommit: sourceCommit,
    });

    const legacyRevision = await sealWhiteboardCandidate(
      created.dir,
      "Legacy Review publication",
    );

    await rm(path.join(created.dir, ".bundle", "software-map"), {
      recursive: true,
      force: true,
    });
    await writeSchema2Record(created.dir, legacyRevision);

    await expect(
      migrateStoredWhiteboardData({ whiteboardHome }),
    ).resolves.toMatchObject({ documents: 1, droppedWhiteboards: 0 });

    const migrated = await readWhiteboardRecord(created.dir);
    expect(migrated.presentedDocumentRevision).not.toBeNull();
    expect(migrated.presentedSoftwareMapRevision).not.toBeNull();
    await expectJsonMapRevision(
      created.dir,
      migrated.presentedSoftwareMapRevision!,
    );
  });

  it("preserves a genuine flat schema-2 embedded map and its sealed pins", async () => {
    const { created } = await flatSchema2Whiteboard("valid");

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

    const result = await migrateStoredWhiteboard({
      whiteboardDir: created.dir,
    });

    expect(result.record.schemaVersion).toBe(5);
    expect(result.record.presentedSoftwareMapRevision).not.toBeNull();

    const materialized = await materializedRevision(
      created.dir,
      result.record.presentedSoftwareMapRevision!,
    );

    const bundle = await readWhiteboardSoftwareMapBundle(materialized);
    expect(
      bundle &&
        softwareModelDataSchema.parse({
          elements: jsonObject(parseJsonText(bundle.headJson))?.elements,
          relationships: jsonObject(parseJsonText(bundle.headJson))
            ?.relationships,
        }).elements,
    ).toEqual(
      defineSoftwareMap({ systems: { service: { label: "Head" } } }).elements,
    );
    expect(
      bundle &&
        softwareModelDataSchema.parse({
          elements: jsonObject(parseJsonText(bundle.baseJson))?.elements,
          relationships: jsonObject(parseJsonText(bundle.baseJson))
            ?.relationships,
        }).elements,
    ).toEqual(
      defineSoftwareMap({ systems: { service: { label: "Base" } } }).elements,
    );
    expect(bundle?.headCommit).toBe(created.review.sourceCommit);
    expect(bundle?.baseCommit).toBe(created.review.baseCommit);
    expect(result.record.sourceCommit).toBe("f".repeat(40));
    expect(result.record.baseCommit).toBe("e".repeat(40));
  });

  it("preserves the original flat schema-2 review when its embedded map pair is invalid", async () => {
    const { created } = await flatSchema2Whiteboard("invalid");
    const before = await snapshotMigrationFiles(created.dir);
    await expect(
      migrateStoredWhiteboard({ whiteboardDir: created.dir }),
    ).rejects.toThrow("embedded software map");
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("does not invent an embedded repository map from inline flat schema-2 models", async () => {
    const { created } = await flatSchema2Whiteboard("absent");

    const result = await migrateStoredWhiteboard({
      whiteboardDir: created.dir,
    });

    expect(result.record.schemaVersion).toBe(5);
    expect(result.record.presentedSoftwareMapRevision).toBeNull();

    const materialized = await materializedRevision(
      created.dir,
      result.record.presentedDocumentRevision!,
    );

    const bundle = await readWhiteboardDocumentBundle(materialized, "/");
    expect(
      bundle && whiteboardDocumentBundleData(bundle).softwareModels,
    ).toHaveLength(2);
  });

  it("migrates a schema-2 review with missing legacy maps without a blocker", async () => {
    const { created, whiteboardHome } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);

    const legacyRevision = await sealWhiteboardCandidate(
      created.dir,
      "Legacy Review publication without a map",
    );

    await writeSchema2Record(created.dir, legacyRevision);
    const blockers: string[] = [];

    await expect(
      migrateStoredWhiteboardData({
        whiteboardHome,
        onBlocker: (message) => blockers.push(message),
      }),
    ).resolves.toMatchObject({ documents: 1, droppedWhiteboards: 0 });

    expect(blockers).toEqual([]);
    const migrated = await readWhiteboardRecord(created.dir);
    expect(migrated.presentedDocumentRevision).not.toBeNull();
    expect(migrated.presentedSoftwareMapRevision).toBeNull();
  });

  it("converts a schema-4 legacy map independently and skips artifact work on a repeated sweep", async () => {
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();

    const documentRevision = await sealWhiteboardCandidate(
      created.dir,
      "Published Session document",
    );

    await writeLegacySoftwareMapBundle(created.dir, {
      baseCommit: sourceCommit,
      headCommit: sourceCommit,
    });

    const legacyMapRevision = await sealWhiteboardCandidate(
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
      migrateStoredWhiteboardData({ whiteboardHome }),
    ).resolves.toMatchObject({ documents: 1, droppedWhiteboards: 0 });

    const migrated = await readWhiteboardRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(documentRevision);
    expect(migrated.presentedSoftwareMapRevision).not.toBe(legacyMapRevision);
    expect(migrated.presentedSoftwareMapRevision).not.toBe(documentRevision);
    await expectJsonMapRevision(
      created.dir,
      migrated.presentedSoftwareMapRevision!,
    );
    const migratedMapRevision = migrated.presentedSoftwareMapRevision;
    const before = await snapshotWhiteboardTree(created.dir);
    const materialize = vi.spyOn(whiteboardVcs, "materialize");
    const seal = vi.spyOn(whiteboardVcs, "seal");
    const legacyRepos = path.join(whiteboardHome, "repos");
    await mkdir(legacyRepos);
    await writeFile(path.join(legacyRepos, "legacy-cache"), "retired");
    const repeated = await migrateStoredWhiteboardData({ whiteboardHome });
    expect(repeated).toMatchObject({
      documents: 1,
      droppedWhiteboards: 0,
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(await snapshotWhiteboardTree(created.dir)).toEqual(before);
    await expect(stat(legacyRepos)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readWhiteboardRecord(created.dir)).presentedSoftwareMapRevision,
    ).toBe(migratedMapRevision);
  });

  it("leaves a current valid JSON map revision unchanged", async () => {
    const { created, whiteboardHome, sourceCommit } = await storedWhiteboard();

    const documentRevision = await sealWhiteboardCandidate(
      created.dir,
      "Published Session document",
    );

    const model = defineSoftwareMap({
      systems: { service: { label: "Service" } },
    });

    await writeWhiteboardSoftwareMapBundle(
      created.dir,
      bundleWhiteboardSoftwareMap({
        head: model,
        base: model,
        headCommit: sourceCommit,
        baseCommit: sourceCommit,
      }),
    );

    const mapRevision = await sealWhiteboardCandidate(
      created.dir,
      "Published JSON software map",
    );

    await writeCurrentRecord(created.dir, {
      presentedDocumentRevision: documentRevision,
      presentedSoftwareMapRevision: mapRevision,
    });

    await expect(
      migrateStoredWhiteboardData({ whiteboardHome }),
    ).resolves.toMatchObject({ documents: 1, droppedWhiteboards: 0 });

    const migrated = await readWhiteboardRecord(created.dir);
    expect(migrated.presentedDocumentRevision).toBe(documentRevision);
    expect(migrated.presentedSoftwareMapRevision).toBe(mapRevision);
  });

  it("preserves current draft authoring with removed code peek fields", async () => {
    const whiteboardHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();

    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    const created = await createWhiteboardDir({
      reviewsHomePath: whiteboardHome,
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
      migrateStoredWhiteboardData({
        whiteboardHome,
        log: (message) => log.push(message),
      }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekWhiteboards: 0,
      droppedWhiteboards: 0,
    });
    expect(log).not.toContain(expect.stringContaining("Dropped Review"));
    await expect(
      readFile(path.join(created.dir, "review.json")),
    ).resolves.toBeDefined();
  });

  it("keeps range Whiteboards that only mention removed field names", async () => {
    const whiteboardHome = await tempDir("review-migration-");
    const sourceRoot = await gitRepository();

    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    const created = await createWhiteboardDir({
      reviewsHomePath: whiteboardHome,
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
      migrateStoredWhiteboardData({ whiteboardHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekWhiteboards: 0,
      droppedWhiteboards: 0,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain(created.review.uuid);
  });
});

describe("migrateStoredWhiteboard", () => {
  it("upgrades one schema-4 review in place and is a byte-level no-op on repeat", async () => {
    const { created } = await storedWhiteboard();
    await writeLegacyDocument(created.dir);

    const revision = await sealWhiteboardCandidate(
      created.dir,
      "Legacy document",
    );

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

    const first = await migrateStoredWhiteboard({ whiteboardDir: created.dir });

    expect(first.migrated).toBe(true);
    const record = await readWhiteboardRecord(created.dir);
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
    const materialized = await tempDir("review-migration-");
    await materializeWhiteboardRevision(
      created.dir,
      record.presentedDocumentRevision!,
      materialized,
    );
    const bundle = await readWhiteboardDocumentBundle(materialized, "/");
    expect(bundle && whiteboardDocumentBundleData(bundle).title).toBe("Sealed");

    const before = await snapshotMigrationFiles(created.dir);
    const materialize = vi.spyOn(whiteboardVcs, "materialize");
    const seal = vi.spyOn(whiteboardVcs, "seal");

    const second = await migrateStoredWhiteboard({
      whiteboardDir: created.dir,
    });

    expect(second.migrated).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
  });

  it("leaves a review untouched when its sealed document is broken", async () => {
    const { created } = await storedWhiteboard();
    await writeLegacyDocument(created.dir, {
      code: 'import { jsx } from "review-doc-runtime"; throw new Error("broken sealed document");',
    });

    const revision = await sealWhiteboardCandidate(
      created.dir,
      "Broken document",
    );

    const legacy = JSON.stringify({
      ...created.review,
      schemaVersion: 4,
      presentedDocumentRevision: revision,
    });

    await writeFile(path.join(created.dir, "review.json"), legacy);
    const before = await snapshotMigrationFiles(created.dir);

    await expect(
      migrateStoredWhiteboard({ whiteboardDir: created.dir }),
    ).rejects.toThrow("broken sealed document");

    expect(await snapshotMigrationFiles(created.dir)).toEqual(before);
    expect(await readFile(path.join(created.dir, "review.json"), "utf8")).toBe(
      legacy,
    );
  });
});

async function flatSchema2Whiteboard(maps: "valid" | "invalid" | "absent") {
  const fixture = await storedWhiteboard();
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
import { createActiveWhiteboardDocument, defineSoftwareModel, jsx } from "review-doc-runtime";
const head = defineSoftwareModel({ systems: { service: { label: "Head" } } });
const base = defineSoftwareModel({ systems: { service: { label: "Base" } } });
export default createActiveWhiteboardDocument({ title: "Flat", routePath: "/", filePath: "review.mdx", modelNames: [], models: {},
repoSoftwareMap: ${maps === "absent" ? "null" : "head"}, baseSoftwareMap: ${maps === "valid" ? "base" : "null"},
Component: () => jsx("p", { children: "Sealed flat document" }), isDefault: true });
`,
  );

  const revision = await sealWhiteboardCandidate(
    fixture.created.dir,
    "Flat schema-2 publication",
  );

  await writeSchema2Record(fixture.created.dir, revision);

  return fixture;
}

async function storedWhiteboard() {
  const whiteboardHome = await tempDir("review-migration-");
  const sourceRoot = await gitRepository();

  const sourceCommit = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();

  const created = await createWhiteboardDir({
    reviewsHomePath: whiteboardHome,
    worktreePath: sourceRoot,
    baseRef: "main",
    baseCommit: sourceCommit,
    sourceCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });

  await writeWhiteboardDocumentBundle(
    created.dir,
    bundleWhiteboardDocument({
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

  return { created, whiteboardHome, sourceCommit };
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
  whiteboardDir: string,
  commits: { headCommit: string; baseCommit: string },
): Promise<void> {
  const mapDir = path.join(whiteboardDir, ".bundle", "software-map");

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
  whiteboardDir: string,
  presentedRevision: string,
): Promise<void> {
  const current = await readWhiteboardRecord(whiteboardDir);

  const {
    presentedDocumentRevision: _documentRevision,
    presentedSoftwareMapRevision: _mapRevision,
    schemaVersion: _schemaVersion,
    ...legacy
  } = current;

  await writeFile(
    path.join(whiteboardDir, "review.json"),
    `${JSON.stringify({
      ...legacy,
      schemaVersion: 2,
      presentedRevision,
    })}\n`,
  );
}

async function writeCurrentRecord(
  whiteboardDir: string,
  revisions: {
    schemaVersion?: 4;
    presentedDocumentRevision: string;
    presentedSoftwareMapRevision: string;
  },
): Promise<void> {
  const current = await readWhiteboardRecord(whiteboardDir);
  await writeFile(
    path.join(whiteboardDir, "review.json"),
    `${JSON.stringify({ ...current, ...revisions })}\n`,
  );
}

async function readWhiteboardRecord(whiteboardDir: string) {
  return parseStoredWhiteboardRecord(
    parseJsonText(
      await readFile(path.join(whiteboardDir, "review.json"), "utf8"),
    ),
  );
}

async function materializedRevision(
  whiteboardDir: string,
  revision: string,
): Promise<string> {
  const destination = path.join(whiteboardDir, ".build", `test-${revision}`);
  await materializeWhiteboardRevision(whiteboardDir, revision, destination);

  return destination;
}

async function expectJsonMapRevision(
  whiteboardDir: string,
  revision: string,
): Promise<void> {
  const mapRevisionDir = await materializedRevision(whiteboardDir, revision);
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
