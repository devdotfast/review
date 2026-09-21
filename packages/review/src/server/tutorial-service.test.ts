import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { selectSource } from "../lens-selection";
import {
  elements,
  resourceReferences,
  sourceReferences,
} from "../review-api/document";
import { openLocalReviewStore } from "../review-api/local-data";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(import.meta.dirname, "../..");

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-tutorial-"));
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const assets = path.join(home, "package");
  await cp(path.join(packageRoot, "tutorial"), path.join(assets, "tutorial"), {
    recursive: true,
    filter: (source) => !source.includes("/.bundle"),
  });
  const local = openLocalReviewStore(path.join(home, "reviews.db"));
  cleanups.push(async () => {
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  });

  return {
    home,
    assets,
    ...local,
    service: createTutorialService({ packageRoot: assets, ...local }),
  };
}

it("opens all shipped native evidence with retained maps and trace, without a legacy record", async () => {
  const { service, store, data, home } = await setup();
  const snapshot = await service.prepare();
  expect(await service.prepare()).toEqual(snapshot);
  expect(store.list()).toEqual([]);

  for (const { source } of sourceReferences(snapshot.document))
    expect(
      await data.file(snapshot.pins, source.side, source.file),
    ).toBeTruthy();

  for (const block of resourceReferences(snapshot.document))
    await data.validateResource(snapshot.pins, block);
  expect(
    elements(snapshot.document).some((block) => block.type === "trace_quote"),
  ).toBe(true);
  await expect(
    readFile(path.join(home, "reviews", snapshot.reviewId, "review.json")),
  ).rejects.toThrow("ENOENT");
  expect((await service.status()).reviewUuid).toBe(snapshot.reviewId);
});

it("refreshes changed native content even when source pins do not change", async () => {
  const { service, assets, store } = await setup();
  const old = await service.prepare();
  const file = path.join(assets, "tutorial/document.json");
  const authored = JSON.parse(await readFile(file, "utf8"));
  authored.document.push({ type: "markdown", markdown: "An updated tour." });
  await writeFile(file, JSON.stringify(authored));
  const next = await service.prepare();
  expect(next.reviewId).not.toBe(old.reviewId);
  expect(next.pins).toEqual(old.pins);
  expect(next.document.at(-1)).toMatchObject({ markdown: "An updated tour." });
  expect(store.has(old.reviewId)).toBe(false);
});

it("repairs missing source repositories and recreates a deleted native tutorial", async () => {
  const { service, home, store } = await setup();
  const first = await service.prepare();
  await rm(path.join(home, "tutorial/sample-service"), { recursive: true });
  expect((await service.status()).reviewUuid).toBeNull();
  const repaired = await service.prepare();
  expect(repaired.reviewId).not.toBe(first.reviewId);
  expect(store.has(first.reviewId)).toBe(false);
  await service.cleanup();
  expect(store.has(repaired.reviewId)).toBe(false);
  const fresh = await service.prepare();
  expect(fresh.reviewId).not.toBe(repaired.reviewId);
});

it.each(["old", "corrupt"])(
  "replaces %s preparation stamps without invoking a legacy importer",
  async (kind) => {
    const { service, home, store } = await setup();
    const old = await service.prepare();
    await writeFile(
      path.join(home, "tutorial/stamp.json"),
      kind === "old"
        ? JSON.stringify({ version: 9, reviewUuid: old.reviewId })
        : "{",
    );
    const next = await service.prepare();
    expect(next.reviewId).not.toBe(old.reviewId);
    expect(store.has(old.reviewId)).toBe(false);
  },
);

it("rejects invalid shipped source references before saving a document", async () => {
  const { service, assets, store } = await setup();
  const file = path.join(assets, "tutorial/document.json");
  const authored = JSON.parse(await readFile(file, "utf8"));
  authored.document.push({
    type: "code_peek",
    source: selectSource({
      side: "head",
      file: "missing.ts",
      fromLine: 1,
      toLine: 2,
    }),
  });
  await writeFile(file, JSON.stringify(authored));
  await expect(service.prepare()).rejects.toThrow(
    "File is unavailable at the pinned commit.",
  );
  expect((await service.status()).reviewUuid).toBeNull();
  expect(store.tutorialIds()).toEqual([]);
});
