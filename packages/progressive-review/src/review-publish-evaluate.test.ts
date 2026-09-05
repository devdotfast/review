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
    expect(result.document).toBeNull();
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

  it("recovers imported anchors omitted by old sealed document exports, including unused anchors", async () => {
    const result = await evaluateReviewDocumentBundleForPublish({
      reviewDir: fixtureDir("review"),
      validateRanges: false,
      bundleCode: `import { createBrowserReviewDefinitionSession, createActiveReviewDocument, jsx } from "review-doc-runtime";
        const session = createBrowserReviewDefinitionSession({});
        const anchors = session.defineAnchors({ shown: { title: "Shown", peek: { file: "x.ts", fromLine: 1, toLine: 1 } }, unused: { title: "Unused", peek: { file: "x.ts", fromLine: 2, toLine: 2 } } });
        export default createActiveReviewDocument({ title: "Legacy", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: ({ components }) => jsx(components.AnchorLink, { anchor: anchors.shown, children: "Shown" }), isDefault: true });`,
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.document!.anchors).sort()).toEqual([
      "shown",
      "unused",
    ]);
  });

  it("materializes document metadata, nodes, anchors, and ordered software models", async () => {
    const reviewDir = fixtureDir("review");
    const head = sourceFixture("one line");
    const result = await evaluateReviewDocumentBundleForPublish({
      reviewDir,
      bundleCode: `
        import React, {
          createActiveReviewDocument,
          createBrowserReviewDefinitionSession,
          defineSoftwareModel,
        } from "review-doc-runtime";
        const session = createBrowserReviewDefinitionSession({
          softwareMap: null,
          baseSoftwareMap: null,
        });
        const anchors = session.defineAnchors({
          request: {
            title: "Request",
            peek: { file: "src/example.ts", fromLine: 1, toLine: 1 },
          },
          unused: {
            title: "Unused imported anchor",
            peek: { file: "src/example.ts", fromLine: 1, toLine: 1 },
          },
        });
        const first = defineSoftwareModel({
          systems: { first: { label: "First" } },
        });
        const second = defineSoftwareModel({
          systems: { second: { label: "Second" } },
        });
        await session.ready();
        createActiveReviewDocument({
          title: "Materialized",
          routePath: "/guide",
          filePath: "/repo/review.mdx",
          modelNames: ["second"],
          models: { anchors, importedModel: first, ignored: first, second },
          Component: ({ components }) => React.createElement(
            React.Fragment,
            null,
            React.createElement("h1", {
              "data-review-block-index": 0,
              "data-review-block-tag": "h1",
            }, "Materialized"),
            React.createElement(components.CodePeek, {
              anchor: anchors.request,
            }),
          ),
        });
      `,
      prepareEvidence: async () => ({ head: { sourceRootPath: head } }),
    });

    expect(result.errors).toEqual([]);
    expect(result.document).toMatchObject({
      title: "Materialized",
      routePath: "/guide",
      sourcePath: "review.mdx",
      body: [
        {
          type: "element",
          tag: "h1",
          children: [{ type: "text", value: "Materialized" }],
        },
        { type: "component", name: "CodePeek", children: [] },
      ],
    });
    expect(result.document?.anchors.request?.peek?.resolution).toBeNull();
    expect(result.document?.anchors.unused?.title).toBe(
      "Unused imported anchor",
    );
    expect(
      result.document?.softwareModels.map((model) => model.elements[0]?.label),
    ).toEqual(["Second", "First"]);
  });

  it("returns no document after audit or document-schema failures", async () => {
    const auditFailure = await evaluateReviewDocumentBundleForPublish({
      reviewDir: fixtureDir("review"),
      bundleCode: bundleWithDocumentBody(
        `React.createElement(components.CodePeek, {})`,
      ),
    });
    expect(auditFailure.errors.length).toBeGreaterThan(0);
    expect(auditFailure.document).toBeNull();

    const documentLocalComponent = await evaluateReviewDocumentBundleForPublish(
      {
        reviewDir: fixtureDir("review"),
        bundleCode: bundleWithDocumentBody(
          `React.createElement(() => React.createElement("p", null, "Local"))`,
        ),
      },
    );
    expect(documentLocalComponent.errors).toContain(
      "Document-local components are not supported; use the Review components.",
    );
    expect(documentLocalComponent.document).toBeNull();

    const schemaFailure = await evaluateReviewDocumentBundleForPublish({
      reviewDir: fixtureDir("review"),
      bundleCode: bundleWithDocumentBody(`React.createElement("video")`),
    });
    expect(schemaFailure.errors.length).toBeGreaterThan(0);
    expect(schemaFailure.document).toBeNull();
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
            title: "Trace quote",
            routePath: "/",
            filePath: "/repo/review.mdx",
            modelNames: [],
            models: {},
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
            title: "Trace quote",
            routePath: "/",
            filePath: "/repo/review.mdx",
            modelNames: [],
            models: {},
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
            title: "Trace quote",
            routePath: "/",
            filePath: "/repo/review.mdx",
            modelNames: [],
            models: {},
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

  it("serializes concurrent evaluations that share the process-global runtime", async () => {
    const reviewDir = fixtureDir("review");
    const events: string[] = [];
    vi.stubGlobal("__reviewEvaluationEvents", events);
    const slow = `
      globalThis.__reviewEvaluationEvents.push("first:enter");
      ${bundleWithAnchors("")
        .replace('title: "Fixture"', 'title: "First"')
        .replace(
          "await session.ready();",
          "await new Promise((resolve) => setTimeout(resolve, 150)); await session.ready();",
        )}
      globalThis.__reviewEvaluationEvents.push("first:exit");
    `;
    const fast = `
      globalThis.__reviewEvaluationEvents.push("second:enter");
      ${bundleWithAnchors("").replace('title: "Fixture"', 'title: "Second"')}
      globalThis.__reviewEvaluationEvents.push("second:exit");
    `;
    try {
      const [first, second] = await Promise.all([
        evaluateReviewDocumentBundleForPublish({
          reviewDir,
          bundleCode: slow,
          validateRanges: false,
        }),
        evaluateReviewDocumentBundleForPublish({
          reviewDir,
          bundleCode: fast,
          validateRanges: false,
        }),
      ]);
      expect(events).toEqual([
        "first:enter",
        "first:exit",
        "second:enter",
        "second:exit",
      ]);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
      expect(first.document?.title).toBe("First");
      expect(second.document?.title).toBe("Second");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("continues queued evaluations after an evaluation rejects", async () => {
    const reviewDir = fixtureDir("review");
    const invalidReviewDir = path.join(reviewDir, "not-a-directory");
    fs.writeFileSync(invalidReviewDir, "occupied");
    const failed = evaluateReviewDocumentBundleForPublish({
      reviewDir: invalidReviewDir,
      bundleCode: bundleWithAnchors(""),
      validateRanges: false,
    });
    const next = evaluateReviewDocumentBundleForPublish({
      reviewDir,
      bundleCode: bundleWithAnchors(""),
      validateRanges: false,
    });

    await expect(failed).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(next).resolves.toMatchObject({
      errors: [],
      document: { title: "Fixture" },
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
    const anchors = session.defineAnchors({ ${anchors} });
    await session.ready();
    createActiveReviewDocument({
      title: "Fixture",
      routePath: "/",
      filePath: "/repo/review.mdx",
      modelNames: [],
      models: { anchors },
      Component: () => null,
    });
  `;
}

function bundleWithDocumentBody(body: string): string {
  return `
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
      title: "Fixture",
      routePath: "/",
      filePath: "/repo/review.mdx",
      modelNames: [],
      models: {},
      Component: ({ components }) => ${body},
    });
  `;
}
