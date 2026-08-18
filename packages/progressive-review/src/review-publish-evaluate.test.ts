import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ReviewPublishEvidenceTargets,
  evaluateReviewDocumentBundleForPublish,
} from "./review-publish-evaluate";

describe("publish range evaluation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads head and base peeks from their exact pinned worktrees", async () => {
    const reviewDir = fixtureDir("review");
    const head = sourceFixture("head line");
    const base = sourceFixture("base line");
    const prepareEvidence = vi.fn<() => Promise<ReviewPublishEvidenceTargets>>(
      async () => ({
        head: { sourceRootPath: head },
        base: { sourceRootPath: base },
      }),
    );

    const result = await evaluateReviewDocumentBundleForPublish({
      reviewDir,
      bundleCode: bundleWithAnchors(`
        head: {
          title: "Head",
          peek: { file: "src/example.ts", fromLine: 1, toLine: 1 },
        },
        base: {
          title: "Base",
          peek: {
            file: "src/example.ts",
            fromLine: 1,
            toLine: 1,
            graph: "base",
          },
        },
      `),
      prepareEvidence,
    });

    expect(result.errors).toEqual([]);
    expect(result.peekCount).toBe(2);
    expect(result.rangePeeks).toEqual([
      expect.objectContaining({ anchorId: "head" }),
      expect.objectContaining({ anchorId: "base", graph: "base" }),
    ]);
    expect(prepareEvidence).toHaveBeenCalledTimes(1);
  });

  it("reports a range outside the selected pinned file", async () => {
    const reviewDir = fixtureDir("review");
    const head = sourceFixture("one line");

    const result = await evaluateReviewDocumentBundleForPublish({
      reviewDir,
      bundleCode: bundleWithAnchors(`
        invalid: {
          title: "Invalid",
          peek: { file: "src/example.ts", fromLine: 1, toLine: 4 },
        },
      `),
      prepareEvidence: async () => ({ head: { sourceRootPath: head } }),
    });

    expect(result.errors).toEqual([
      expect.stringContaining("Source range src/example.ts:1-4 exceeds"),
    ]);
  });

  it("does not prepare a worktree when the document has no peeks", async () => {
    const prepareEvidence =
      vi.fn<() => Promise<ReviewPublishEvidenceTargets>>();
    const result = await evaluateReviewDocumentBundleForPublish({
      reviewDir: fixtureDir("review"),
      bundleCode: bundleWithAnchors('summary: "Summary",'),
      prepareEvidence,
    });

    expect(result).toMatchObject({ peekCount: 0, rangePeeks: [], errors: [] });
    expect(prepareEvidence).not.toHaveBeenCalled();
  });

  function sourceFixture(source: string): string {
    const root = fixtureDir("source");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "example.ts"), source);
    return root;
  }

  function fixtureDir(label: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
    roots.push(root);
    return root;
  }
});

function bundleWithAnchors(anchors: string): string {
  return `
    import {
      createActiveReviewDocument,
      createBrowserReviewDefinitionSession,
    } from "review-doc-runtime";
    const session = createBrowserReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
    });
    session.defineAnchors({ ${anchors} });
    await session.ready();
    createActiveReviewDocument({ Component: () => null });
  `;
}
