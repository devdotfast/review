import { randomUUID } from "node:crypto";
import {
  cp,
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

import { openLocalSessionStore } from "../session-api/local-data";
import { whiteboardVcs } from "../whiteboard-vcs";
import { scratchGitRepo, syntheticLegacyWhiteboard } from "./import-test-utils";
import { ensureJsonCutover, migrateJsonWhiteboards } from "./json-cutover";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function seed(existing?: string) {
  const home =
    existing ?? (await mkdtemp(path.join(tmpdir(), "json-cutover-test-")));

  if (!existing) homes.push(home);
  const repo = await scratchGitRepo();
  const local = openLocalSessionStore(path.join(home, "review-api.db"));
  const repositoryId = (await local.data.register(repo.root)).id;

  const { sessionId } = await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Already authored",
      pins: { repositoryId, base: repo.base, head: repo.head },
    },
  });

  const snapshot = local.store.read(sessionId);
  await local.data.close();
  await local.store.close();

  return { home, sessionId, snapshot };
}

/** The cutover materializes from the review directory's own Git history, so a
 * synthetic review is only importable once its presented revision is sealed
 * there. */
async function sealPresentedRevision(
  review: Awaited<ReturnType<typeof syntheticLegacyWhiteboard>>,
) {
  const sealed = path.join(review.dir, ".revisions", review.oids.at(-1)!);
  await cp(sealed, review.dir, { recursive: true });
  await whiteboardVcs.init(review.dir);
  const revision = await whiteboardVcs.seal(review.dir, "Publish Review");
  const record = { ...review.record, presentedDocumentRevision: revision };
  await writeFile(path.join(review.dir, "review.json"), JSON.stringify(record));

  return record;
}

it("stages failures without replacing the live database and keeps a readable backup", async () => {
  // The record reads cleanly, but nothing sealed the revision it presents, so
  // converting it fails where an unreadable record would only be skipped.
  const failing = await syntheticLegacyWhiteboard(
    "schema4-bug-report-dialog",
    await scratchGitRepo(),
  );

  homes.push(failing.home);
  const { home, sessionId, snapshot } = await seed(failing.home);
  const original = await readFile(path.join(home, "review-api.db"));
  const report = await migrateJsonWhiteboards({ home });
  expect(report.errors).toHaveLength(1);
  expect(await readFile(path.join(home, "review-api.db"))).toEqual(original);
  expect(await readdir(home)).not.toContain("json-cutover.json");
  const saved = openLocalSessionStore(report.backup!);

  try {
    expect(saved.store.read(sessionId)).toEqual(snapshot);
  } finally {
    await saved.data.close();
    await saved.store.close();
  }
});

it("installs a complete candidate once and preserves existing JSON versions", async () => {
  const { home, sessionId, snapshot } = await seed();
  await ensureJsonCutover(home, () => {});
  const backups = await readdir(path.join(home, "backups"));
  await ensureJsonCutover(home, () => {});
  expect(await readdir(path.join(home, "backups"))).toEqual(backups);
  const installed = openLocalSessionStore(path.join(home, "review-api.db"));

  try {
    expect(installed.store.read(sessionId)).toEqual(snapshot);
  } finally {
    await installed.data.close();
    await installed.store.close();
  }
});

it("drops unpublished drafts from the catalog and records the decision without removing originals", async () => {
  const repo = await scratchGitRepo();

  const draft = await syntheticLegacyWhiteboard(
    "schema4-bug-report-dialog",
    repo,
    {
      overrides: { presentedDocumentRevision: null },
    },
  );

  homes.push(draft.home);
  const report = await migrateJsonWhiteboards({ home: draft.home });
  expect(report.errors).toEqual([]);
  expect(report.droppedDrafts).toEqual([
    { sessionId: draft.record.uuid, title: draft.record.title },
  ]);
  const migrated = openLocalSessionStore(report.database);

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

it("skips an unreadable directory, installs the readable reviews and records the skip", async () => {
  const repo = await scratchGitRepo();

  const good = await syntheticLegacyWhiteboard(
    "schema4-bug-report-dialog",
    repo,
  );

  homes.push(good.home);
  const goodRecord = await sealPresentedRevision(good);

  const badId = "11111111-1111-4111-8111-111111111111";
  const badDir = path.join(good.home, "reviews", badId);
  const badRecord = JSON.stringify({ schemaVersion: 1, uuid: badId });
  await mkdir(badDir, { recursive: true });
  await writeFile(path.join(badDir, "review.json"), badRecord);

  const messages: string[] = [];
  await ensureJsonCutover(good.home, (message) => messages.push(message));

  const marker = JSON.parse(
    await readFile(path.join(good.home, "json-cutover.json"), "utf8"),
  );

  expect(marker.errors).toEqual([]);
  expect(marker.skipped).toEqual([
    { sessionId: badId, dir: badDir, reason: expect.any(String) },
  ]);
  expect(messages.join("\n")).toContain(badDir);

  const installed = openLocalSessionStore(
    path.join(good.home, "review-api.db"),
  );

  try {
    expect(installed.store.has(goodRecord.uuid)).toBe(true);
    expect(installed.store.has(badId)).toBe(false);
  } finally {
    await installed.data.close();
    await installed.store.close();
  }

  expect(await readFile(path.join(badDir, "review.json"), "utf8")).toEqual(
    badRecord,
  );

  expect(
    JSON.parse(await readFile(path.join(good.dir, "review.json"), "utf8")),
  ).toEqual(goodRecord);
});

it("starts with healthy reviews when a published review's repository is unavailable", async () => {
  const repo = await scratchGitRepo();

  const good = await syntheticLegacyWhiteboard(
    "schema4-bug-report-dialog",
    repo,
  );

  homes.push(good.home, repo.root);
  const goodRecord = await sealPresentedRevision(good);
  const existing = await seed(good.home);

  const missingPath = path.join(good.home, "removed-repository");

  const unavailable = await syntheticLegacyWhiteboard(
    "schema4-bug-report-dialog",
    { ...repo, root: missingPath },
    { overrides: { uuid: randomUUID(), repoKey: "unavailable-repository" } },
  );

  homes.push(unavailable.home);
  const unavailableRecord = await sealPresentedRevision(unavailable);

  const unavailableDir = path.join(
    good.home,
    "reviews",
    unavailableRecord.uuid,
  );

  await cp(unavailable.dir, unavailableDir, { recursive: true });
  const original = await readFile(path.join(unavailableDir, "review.json"));
  const revision = await whiteboardVcs.log(unavailableDir);

  const messages: string[] = [];
  await ensureJsonCutover(good.home, (message) => messages.push(message));

  const marker = JSON.parse(
    await readFile(path.join(good.home, "json-cutover.json"), "utf8"),
  );

  expect(marker.errors).toEqual([]);
  expect(marker.skipped).toEqual([
    {
      sessionId: unavailableRecord.uuid,
      dir: unavailableDir,
      reason: `repository unavailable at ${missingPath}`,
    },
  ]);
  expect(messages.join("\n")).toContain(missingPath);
  expect(await readFile(path.join(unavailableDir, "review.json"))).toEqual(
    original,
  );
  expect(await whiteboardVcs.log(unavailableDir)).toEqual(revision);

  // A completed cutover must also let subsequent launches open the profile.
  await ensureJsonCutover(good.home, () => {});

  const installed = openLocalSessionStore(
    path.join(good.home, "review-api.db"),
  );

  try {
    expect(installed.store.has(goodRecord.uuid)).toBe(true);
    expect(installed.store.has(unavailableRecord.uuid)).toBe(false);
    expect(installed.store.read(existing.sessionId)).toEqual(existing.snapshot);
  } finally {
    await installed.data.close();
    await installed.store.close();
  }
});
