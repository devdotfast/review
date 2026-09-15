import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  normalizeMigratedRecord,
  readLegacyReviewGolden,
  snapshotReviewTree,
} from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  readReviewDocumentBundle,
  reviewDocumentBundleData,
} from "./review-bundle";
import {
  findReview,
  listReviews,
  materializeReviewRevision,
  readStoredReview,
  sealReviewCandidate,
} from "./review-home";
import { reviewVcs } from "./review-vcs";
import { readReviewSoftwareMapBundle } from "./software-map-bundle";

const execFilePromise = promisify(execFile);

const fixtures = listLegacyReviewFixtures();

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  it("migrates to golden JSON while preserving metadata, stale files and old history", async () => {
    const { home, dir, uuid, originalRecord } = await extract(fixture.name);
    const staleDatabase = await readFile(path.join(dir, "review.db"));
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
    const documentBundle = await readReviewDocumentBundle(documentDir, "/");
    expect(documentBundle && reviewDocumentBundleData(documentBundle)).toEqual(
      await readLegacyReviewGolden(fixture.name, "document"),
    );
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

    expect(await readFile(path.join(dir, "review.db"))).toEqual(staleDatabase);
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
