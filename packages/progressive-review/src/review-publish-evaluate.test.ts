import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
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

  describe("TraceQuote validation", () => {
    const sessionId = "72b3d130-2e72-41b6-8686-527a93d16647";
    let mockR2Dir: string;

    beforeEach(() => {
      mockR2Dir = fixtureDir("mock-r2");
      process.env.TRACE_R2_MODE = "mock";
      process.env.TRACE_R2_MOCK_DIR = mockR2Dir;
      process.env.REVIEW_TEST_TRACE_SEARCH_DIR = fixtureDir("trace-search");
      clearTraceEnvCache();

      const sessionDir = path.join(mockR2Dir, "by-session", sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "meta.json"),
        JSON.stringify({
          session: sessionId,
          repo: "acme/widgets",
          branch: "main",
          pr: null,
          commits: [],
          author: null,
          ts: "2026-08-16T12:00:00Z",
        }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "trace.jsonl"),
        [
          JSON.stringify({
            type: "session",
            id: sessionId,
            cwd: "/repo",
            timestamp: "2026-08-16T12:00:00Z",
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-08-16T12:00:05Z",
            message: { role: "user", content: "Optimize database queries" },
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-08-16T12:01:00Z",
            message: {
              role: "assistant",
              content: "I will rewrite the queries with batching.",
            },
          }),
        ].join("\n"),
      );
    });

    afterEach(() => {
      delete process.env.TRACE_R2_MODE;
      delete process.env.TRACE_R2_MOCK_DIR;
      delete process.env.REVIEW_TEST_TRACE_SEARCH_DIR;
      clearTraceEnvCache();
    });

    it("passes when quote text matches trace", async () => {
      const reviewDir = fixtureDir("review");
      const result = await evaluateReviewDocumentBundleForPublish({
        reviewDir,
        bundleCode: `
          import React, {
            createActiveReviewDocument,
            createBrowserReviewDefinitionSession,
          } from "review-doc-runtime";
          const session = createBrowserReviewDefinitionSession({
            softwareMap: null,
            baseSoftwareMap: null,
          });
          await session.ready();
          createActiveReviewDocument({
            Component: ({ components }) => {
              const TraceQuote = components.TraceQuote;
              return React.createElement(
                TraceQuote,
                { sessionId: "${sessionId}" },
                "Optimize database queries"
              );
            }
          });
        `,
      });

      expect(result.errors).toEqual([]);
    });

    it("fails when quote text is not found in trace", async () => {
      const reviewDir = fixtureDir("review");
      const result = await evaluateReviewDocumentBundleForPublish({
        reviewDir,
        bundleCode: `
          import React, {
            createActiveReviewDocument,
            createBrowserReviewDefinitionSession,
          } from "review-doc-runtime";
          const session = createBrowserReviewDefinitionSession({
            softwareMap: null,
            baseSoftwareMap: null,
          });
          await session.ready();
          createActiveReviewDocument({
            Component: ({ components }) => {
              const TraceQuote = components.TraceQuote;
              return React.createElement(
                TraceQuote,
                { sessionId: "${sessionId}" },
                "Nonexistent text that never happened"
              );
            }
          });
        `,
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("not found in session");
    });

    it("emits warning when event hint is stale", async () => {
      const reviewDir = fixtureDir("review");
      const result = await evaluateReviewDocumentBundleForPublish({
        reviewDir,
        bundleCode: `
          import React, {
            createActiveReviewDocument,
            createBrowserReviewDefinitionSession,
          } from "review-doc-runtime";
          const session = createBrowserReviewDefinitionSession({
            softwareMap: null,
            baseSoftwareMap: null,
          });
          await session.ready();
          createActiveReviewDocument({
            Component: ({ components }) => {
              const TraceQuote = components.TraceQuote;
              return React.createElement(
                TraceQuote,
                { sessionId: "${sessionId}", event: 99 },
                "Optimize database queries"
              );
            }
          });
        `,
      });

      expect(result.errors).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("hint event={99} is stale");
    });
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
