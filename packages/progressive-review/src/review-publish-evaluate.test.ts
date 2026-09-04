import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pullReviewTraceCorpus } from "./review-agent-traces";
import {
  type ReviewPublishEvidenceTargets,
  evaluateReviewDocumentBundleForPublish,
} from "./review-publish-evaluate";
import { createMemoryTraceStoreTransport } from "./trace-store-transport";

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
    const repositoryId = 7;

    beforeEach(async () => {
      process.env.REVIEW_TEST_TRACE_SEARCH_DIR = fixtureDir("trace-search");

      // The corpus is what publish reads. Fill it the way `trace pull` does.
      const transport = createMemoryTraceStoreTransport();
      const trace = [
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
      ].join("\n");
      const compressed = zlib.gzipSync(Buffer.from(`${trace}\n`, "utf8"));
      transport.objects.set(
        `r${repositoryId}/sessions/${sessionId}/main.jsonl.gz`,
        compressed,
      );
      transport.sessions.set(`r${repositoryId}/sessions/${sessionId}`, {
        repositoryId,
        sessionId,
        harness: "claude",
        updatedAt: "2026-08-16T12:01:05Z",
        commits: [],
        objects: [
          {
            name: "main.jsonl.gz",
            size: compressed.byteLength,
            sha256: "0".repeat(64),
          },
        ],
        complete: true,
      });
      await pullReviewTraceCorpus({
        repo: { owner: "acme", repo: "widgets" },
        sessions: [{ id: sessionId }],
        transport,
        repositoryId,
      });
    });

    afterEach(() => {
      delete process.env.REVIEW_TEST_TRACE_SEARCH_DIR;
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

    it("emits one error for a failing TraceQuote behind a passthrough wrapper", async () => {
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
          const Section = ({ children }) => children;
          createActiveReviewDocument({
            Component: ({ components }) => {
              const TraceQuote = components.TraceQuote;
              return React.createElement(
                Section,
                null,
                React.createElement(
                  TraceQuote,
                  { sessionId: "${sessionId}" },
                  "Nonexistent text that never happened"
                )
              );
            }
          });
        `,
      });

      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("not found in session");
    });

    it("still fails when a discarding wrapper drops a failing TraceQuote at render", async () => {
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
          const Discarding = () => React.createElement("footer", null);
          createActiveReviewDocument({
            Component: ({ components }) => {
              const TraceQuote = components.TraceQuote;
              return React.createElement(
                Discarding,
                null,
                React.createElement(
                  TraceQuote,
                  { sessionId: "${sessionId}" },
                  "Nonexistent text that never happened"
                )
              );
            }
          });
        `,
      });

      expect(result.errors.length).toBe(1);
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
