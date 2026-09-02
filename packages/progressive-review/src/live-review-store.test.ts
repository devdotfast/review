import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LiveReviewVersionConflictError,
  commitLiveReviewPage,
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
  it("commits only the expected SQLite version", async () => {
    reviewDir = await mkdtemp(path.join(tmpdir(), "live-review-store-"));
    const page = fixturePage();
    initializeLiveReviewPage(reviewDir, page);
    expect(readLiveReviewPage(reviewDir)).toEqual(page);

    const next = { ...page, version: 1, updatedAt: "2026-09-02T00:00:01.000Z" };
    commitLiveReviewPage(reviewDir, next, 0);
    expect(readLiveReviewPage(reviewDir)).toEqual(next);
    expect(() => commitLiveReviewPage(reviewDir!, next, 0)).toThrow(
      LiveReviewVersionConflictError,
    );
  });
});

function fixturePage(): LiveReviewPage {
  return {
    id: "review-1",
    rootNodeId: "root",
    nodes: {
      root: { id: "root", title: "Review", source: "", children: [] },
    },
    status: "awaiting-agent",
    presentedVersionId: null,
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
