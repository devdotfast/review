import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Block } from "./document.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = {
  repositoryId: "repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
};

const id = "11111111-1111-4111-8111-111111111111";

let directory: string, store: ReviewStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-import-"));

  const providers: ReviewProviders = {
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
});
