import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  LiveReviewVersionConflictError,
  commitLiveReviewPage,
  hasLiveReviewPage,
  initializeLiveReviewPage,
  readLiveReviewPage,
} from "./live-review-store";
import type { LiveReviewPage } from "./live-review-types";

let reviewDir: string | undefined;

afterEach(async () => {
  if (reviewDir) await rm(reviewDir, { recursive: true, force: true });
  reviewDir = undefined;
});

describe("live Review page store", () => {
  it("probes without creating a database", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "live-review-store-"));
    expect(hasLiveReviewPage(reviewDir)).toBe(false);
    expect(existsSync(path.join(reviewDir, "review.db"))).toBe(false);
  });

  it("commits only the expected SQLite version", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "live-review-store-"));
    const page = fixturePage();
    initializeLiveReviewPage(reviewDir, page);
    expect(hasLiveReviewPage(reviewDir)).toBe(true);
    expect(readLiveReviewPage(reviewDir)).toEqual(page);

    const db = new DatabaseSync(path.join(reviewDir, "review.db"));
    const stored = JSON.parse(
      (
        db
          .prepare("SELECT page_json FROM live_review_page WHERE singleton = 1")
          .get() as { page_json: string }
      ).page_json,
    ) as Record<string, unknown>;
    db.close();
    expect(stored).not.toHaveProperty("version");
    expect(stored).not.toHaveProperty("status");
    expect(stored).not.toHaveProperty("presentedVersionId");

    const next = { ...page, version: 1, updatedAt: "2026-09-02T00:00:01.000Z" };
    commitLiveReviewPage(reviewDir, next, 0);
    expect(readLiveReviewPage(reviewDir)).toEqual(next);
    expect(() => commitLiveReviewPage(reviewDir!, next, 0)).toThrow(
      LiveReviewVersionConflictError,
    );
  });

  it("validates the persisted projection on every read", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "live-review-store-"));
    initializeLiveReviewPage(reviewDir, fixturePage());
    const db = new DatabaseSync(path.join(reviewDir, "review.db"));
    const row = db
      .prepare("SELECT page_json FROM live_review_page WHERE singleton = 1")
      .get() as { page_json: string };
    const stored = JSON.parse(row.page_json) as {
      projection: { elements: { root: { props: { nodeId: string } } } };
    };
    stored.projection.elements.root.props.nodeId = "wrong-root";
    db.prepare(
      "UPDATE live_review_page SET page_json = ? WHERE singleton = 1",
    ).run(JSON.stringify(stored));
    db.close();

    expect(() => readLiveReviewPage(reviewDir!)).toThrow();
  });

  it("rejects cycles, orphans, and multiply-parented nodes", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "live-review-store-"));
    const page = fixturePage();
    const child = { id: "child", source: "", children: [] };

    expect(() =>
      initializeLiveReviewPage(reviewDir!, {
        ...page,
        nodes: {
          root: { ...page.nodes.root!, children: ["root"] },
        },
      }),
    ).toThrow();
    expect(() =>
      initializeLiveReviewPage(reviewDir!, {
        ...page,
        nodes: { ...page.nodes, child },
      }),
    ).toThrow();
    expect(() =>
      initializeLiveReviewPage(reviewDir!, {
        ...page,
        nodes: {
          root: { ...page.nodes.root!, children: ["left", "right"] },
          left: { id: "left", source: "", children: ["child"] },
          right: { id: "right", source: "", children: ["child"] },
          child,
        },
      }),
    ).toThrow();
  });
});

function fixturePage(): LiveReviewPage {
  return {
    id: "review-1",
    rootNodeId: "root",
    nodes: {
      root: { id: "root", title: "Review", source: "", children: [] },
    },
    version: 0,
    updatedAt: "2026-09-02T00:00:00.000Z",
    projection: {
      root: "root",
      elements: {
        root: {
          type: "ReviewNode",
          props: { nodeId: "root", depth: 0, title: "Review" },
          children: [],
        },
      },
    },
  };
}
