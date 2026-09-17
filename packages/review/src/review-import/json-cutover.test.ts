import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { scratchGitRepo, syntheticLegacyReview } from "./import-test-utils";
import { ensureJsonCutover, migrateJsonReviews } from "./json-cutover";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function seed() {
  const home = await mkdtemp(path.join(tmpdir(), "json-cutover-test-"));
  homes.push(home);
  const repo = await scratchGitRepo();
  const local = openLocalReviewStore(path.join(home, "review-api.db"));
  const repositoryId = (await local.data.register(repo.root)).id;

  const { reviewId } = await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Already authored",
      pins: { repositoryId, base: repo.base, head: repo.head },
    },
  });

  const snapshot = local.store.read(reviewId);
  await local.data.close();
  await local.store.close();

  return { home, reviewId, snapshot };
}

it("stages failures without replacing the live database and keeps a readable backup", async () => {
  const { home, reviewId, snapshot } = await seed();
  const dir = path.join(home, "reviews", randomUUID());
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.json"), "broken record");
  const original = await readFile(path.join(home, "review-api.db"));
  const report = await migrateJsonReviews({ home });
  expect(report.errors).toHaveLength(1);
  expect(await readFile(path.join(home, "review-api.db"))).toEqual(original);
  expect(await readdir(home)).not.toContain("json-cutover.json");
  const saved = openLocalReviewStore(report.backup!);

  try {
    expect(saved.store.read(reviewId)).toEqual(snapshot);
  } finally {
    await saved.data.close();
    await saved.store.close();
  }
});

it("installs a complete candidate once and preserves existing JSON versions", async () => {
  const { home, reviewId, snapshot } = await seed();
  await ensureJsonCutover(home, () => {});
  const backups = await readdir(path.join(home, "backups"));
  await ensureJsonCutover(home, () => {});
  expect(await readdir(path.join(home, "backups"))).toEqual(backups);
  const installed = openLocalReviewStore(path.join(home, "review-api.db"));

  try {
    expect(installed.store.read(reviewId)).toEqual(snapshot);
  } finally {
    await installed.data.close();
    await installed.store.close();
  }
});

it("drops unpublished drafts from the catalog and records the decision without removing originals", async () => {
  const repo = await scratchGitRepo();

  const draft = await syntheticLegacyReview("schema4-bug-report-dialog", repo, {
    overrides: { presentedDocumentRevision: null },
  });

  homes.push(draft.home);
  const report = await migrateJsonReviews({ home: draft.home });
  expect(report.errors).toEqual([]);
  expect(report.droppedDrafts).toEqual([
    { reviewId: draft.record.uuid, title: draft.record.title },
  ]);
  const migrated = openLocalReviewStore(report.database);

  try {
    expect(migrated.store.has(draft.record.uuid)).toBe(false);
    expect(
      JSON.parse(
        await readFile(path.join(draft.stored.dir, "review.json"), "utf8"),
      ),
    ).toEqual(draft.record);
  } finally {
    await migrated.data.close();
    await migrated.store.close();
  }

  await ensureJsonCutover(draft.home, () => {});
});
