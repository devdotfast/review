import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Block } from "./document.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = {
  repositoryId: "repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
};

const id = "11111111-1111-4111-8111-111111111111";

let directory: string, store: ReviewStore, providers: ReviewProviders;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-import-"));

  providers = {
    validatePins: vi.fn<ReviewProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<ReviewProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<ReviewProviders["validateResource"]>(
      async () => {},
    ),
  };

  store = new ReviewStore(path.join(directory, "reviews.db"), providers);
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("importVersion", () => {
  it("writes version 0 with server ids, createdAt, origin and attention", async () => {
    expect(store.has(id)).toBe(false);

    const result = await store.importVersion({
      reviewId: id,
      title: "Imported",
      pins,
      document: [
        {
          type: "section",
          title: "Intro",
          children: [{ type: "markdown", markdown: "# Imported\n\nHello.\n" }],
        },
      ],
      createdAt: "2026-01-02T03:04:05.000Z",
      origin: {
        branch: "feat/x",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/o/r/pull/42",
      },
      attention: { viewedAt: "2026-01-03T00:00:00.000Z", dismissedAt: null },
    });

    expect(result).toEqual({ version: 0, warnings: [] });
    expect(store.has(id)).toBe(true);
    const snapshot = store.read(id);
    expect(snapshot.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(snapshot.origin).toEqual({
      branch: "feat/x",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/o/r/pull/42",
    });
    expect(snapshot.document[0]!.id).toBe("block-1");
    expect(
      (snapshot.document[0] as { children: Block[] }).children[0]!.id,
    ).toBe("block-2");
    const listed = store.list().find((row) => row.reviewId === id)!;
    expect(listed.viewedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(listed.origin?.pullRequestNumber).toBe(42);
  });

  it("appends versions for an existing review and keeps ids unique", async () => {
    await store.importVersion({
      reviewId: id,
      title: "v0",
      pins,
      document: [{ type: "divider" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await store.importVersion({
      reviewId: id,
      title: "v1",
      pins,
      document: [{ type: "divider" }, { type: "divider" }],
      createdAt: "2026-01-05T00:00:00.000Z",
    });

    expect(result.version).toBe(1);
    expect(store.read(id).title).toBe("v1");
    expect(store.read(id).document.map((block) => block.id)).toEqual([
      "block-2",
      "block-3",
    ]);
    expect(store.read(id, 0).document.map((block) => block.id)).toEqual([
      "block-1",
    ]);
  });

  it("notifies catalog and document subscribers", async () => {
    const catalog = vi.fn<() => void>();
    const documents = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>();
    store.subscribeCatalog(catalog);
    store.subscribe(documents);
    await store.importVersion({
      reviewId: id,
      title: "v0",
      pins,
      document: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(documents).toHaveBeenCalledWith({ reviewId: id, version: 0 });
  });

  it("rejects blocks that carry ids", async () => {
    await expect(
      store.importVersion({
        reviewId: id,
        title: "Ids",
        pins,
        document: [{ id: "x", type: "divider" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/IDs are assigned by the server/);
    expect(store.has(id)).toBe(false);
  });

  it("leaves the map cursor for the importer to record", async () => {
    await store.importVersion({
      reviewId: id,
      title: "Imported",
      pins,
      document: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: { revision: "rev-1" },
    });

    expect(store.legacyImport(id)).toMatchObject({
      revision: "rev-1",
      mapRevision: null,
    });
  });

  it("adds map progress to a database written before it existed", async () => {
    const file = path.join(directory, "legacy.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE legacy_imports(review_id TEXT PRIMARY KEY, revision TEXT NOT NULL, imported_at TEXT NOT NULL)",
    );
    legacy
      .prepare(
        "INSERT INTO legacy_imports(review_id,revision,imported_at) VALUES(?,?,?)",
      )
      .run(id, "rev-1", "2026-01-01T00:00:00.000Z");
    legacy.close();
    const upgraded = new ReviewStore(file, providers);

    try {
      expect(upgraded.legacyImport(id)).toEqual({
        revision: "rev-1",
        mapRevision: null,
        importedAt: "2026-01-01T00:00:00.000Z",
      });
      upgraded.recordLegacyImport(id, {
        revision: "rev-1",
        mapRevision: "map-1",
      });
      expect(upgraded.legacyImport(id)?.mapRevision).toBe("map-1");
    } finally {
      await upgraded.close();
    }
  });

  it("writes nothing when a later version fails validation", async () => {
    const catalog = vi.fn<() => void>();
    store.subscribeCatalog(catalog);
    await expect(
      store.importVersions([
        {
          reviewId: id,
          title: "v0",
          pins,
          document: [{ type: "divider" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          reviewId: id,
          title: "v1",
          pins,
          document: [{ id: "x", type: "divider" }],
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    ).rejects.toThrow(/IDs are assigned by the server/);
    expect(store.has(id)).toBe(false);
    expect(catalog).not.toHaveBeenCalled();
  });
});

it("lists linked worktrees under one repository without changing source pins", async () => {
  const main = path.join(directory, "main");
  const linked = path.join(directory, "linked");

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  git("init", main);
  git(
    "-C",
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  git("-C", main, "worktree", "add", "-b", "linked", linked);

  const mainRepo = store.registerRepository(main);
  const linkedRepo = store.registerRepository(linked);

  expect(mainRepo.id).not.toBe(linkedRepo.id);

  for (const [index, repository] of [mainRepo, linkedRepo].entries()) {
    await store.importVersion({
      reviewId: `worktree-${index}`,
      title: `Review ${index}`,
      pins: { ...pins, repositoryId: repository.id },
      document: [],
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  }

  const first = store.list();

  expect(first[0]?.repositoryGroup).toBeDefined();
  expect(first[0]?.repositoryGroup).toEqual(first[1]?.repositoryGroup);
  expect(new Set(first.map((review) => review.pins?.repositoryId)).size).toBe(
    2,
  );

  git(
    "-C",
    main,
    "remote",
    "add",
    "origin",
    "git@github.com:devdotfast/review.git",
  );

  // A new catalog session sees the remote shared imports use, including on old records.
  await store.close();
  store = new ReviewStore(path.join(directory, "reviews.db"), providers);

  expect(store.list().map((review) => review.repositoryGroup)).toEqual([
    {
      key: "remote:https://github.com/devdotfast/review.git",
      label: "devdotfast/review",
    },
    {
      key: "remote:https://github.com/devdotfast/review.git",
      label: "devdotfast/review",
    },
  ]);
});
