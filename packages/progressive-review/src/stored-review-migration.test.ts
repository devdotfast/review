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
import { afterEach, describe, expect, it } from "vitest";

import {
  createReviewDir,
  materializeReviewRevision,
  parseStoredReviewRecord,
  sealReviewCandidate,
} from "./review-home";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";
import { migrateStoredReviewData } from "./stored-review-migration";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("migrateStoredReviewData", () => {
  it("deletes reviews from before the hard schema cutover", async () => {
    const reviewHome = await tempDir();
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const reviewDir = path.join(reviewHome, "reviews", uuid);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "review.json"),
      `${JSON.stringify({ schemaVersion: 1, uuid })}\n`,
    );

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ droppedReviews: 1, documents: 0 });
    await expect(
      readFile(path.join(reviewDir, "review.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a legacy draft and removes legacy thread files", async () => {
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
      droppedComments: 1,
      droppedQuestions: 1,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"schemaVersion": 4');
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"sourceSession": "disabled:review"');
    await expect(
      readFile(path.join(created.dir, "comments.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a schema-2 software map from its sealed JavaScript bundle", async () => {
    const { created, reviewHome, sourceCommit } = await storedReview();
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

  it("drops a current Review that uses removed code peek fields", async () => {
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
      documents: 0,
      droppedLegacyPeekReviews: 1,
      droppedReviews: 1,
    });
    expect(log).toContain(
      `Dropped Review ${created.review.uuid} with removed peek fields: declarationId, symbol.`,
    );
    await expect(
      readFile(path.join(created.dir, "review.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
  return { created, reviewHome, sourceCommit };
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
