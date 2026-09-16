import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { importLegacyReview } from "./import-review";
import {
  logFromRevisionDirs,
  materializeFromRevisionDirs,
  scratchGitRepo,
  syntheticLegacyReview,
} from "./import-test-utils";

describe("importLegacyReview", () => {
  it("imports every sealed revision as a version, oldest first", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 3 },
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

      expect(outcome).toMatchObject({
        kind: "imported",
        reviewId: record.uuid,
        version: 2,
      });
      expect(store.read(record.uuid, 0).title).toBe(record.title);
      expect(store.read(record.uuid, 0).createdAt).toBe(
        new Date(1_700_000_000 * 1000).toISOString(),
      );
      expect(store.read(record.uuid).version).toBe(2);
      expect(store.read(record.uuid).pins).toEqual({
        repositoryId: expect.any(String),
        base: repo.base,
        head: repo.head,
      });
      expect(store.read(record.uuid).origin).toMatchObject({
        branch: record.sourceIdentity?.name,
        baseRef: record.baseRef,
        revision: oids[2],
      });
      // Older revisions keep the pins they were sealed with.
      expect(store.read(record.uuid, 0).pins.head).toBe(repo.base);
      expect(store.read(record.uuid, 2).pins.head).toBe(repo.head);
      expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);
      expect(
        await importLegacyReview({
          review: stored,
          store,
          data,
          materialize: materializeFromRevisionDirs,
          log: logFromRevisionDirs(oids),
        }),
      ).toEqual({ kind: "current", reviewId: record.uuid });
    } finally {
      await store.close();
    }
  });

  it("skips system, never-published and repository-less reviews", async () => {
    const repo = await scratchGitRepo();

    const system = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { overrides: { visibility: "system" } },
    );

    const never = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { overrides: { presentedDocumentRevision: null } },
    );

    const gone = await syntheticLegacyReview(
      "schema4-opencode-agentserver",
      repo,
      { overrides: { worktreePath: path.join(repo.root, "missing") } },
    );

    const { store, data } = openLocalReviewStore(
      path.join(system.home, "review-api.db"),
    );

    try {
      const outcomes = [];

      for (const fixture of [system, never, gone])
        outcomes.push(
          await importLegacyReview({
            review: fixture.stored,
            store,
            data,
            materialize: materializeFromRevisionDirs,
            log: logFromRevisionDirs(fixture.oids),
          }),
        );

      expect(outcomes).toEqual([
        {
          kind: "skipped",
          reviewId: system.record.uuid,
          reason: "system review",
        },
        {
          kind: "skipped",
          reviewId: never.record.uuid,
          reason: "never published",
        },
        {
          kind: "skipped",
          reviewId: gone.record.uuid,
          reason: `repository unavailable at ${path.join(repo.root, "missing")}`,
        },
      ]);
      expect(store.has(never.record.uuid)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("preserves unavailable quotes and reports import warnings outside the document", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    const docPath = path.join(
      stored.dir,
      ".revisions",
      oids[0]!,
      ".bundle/document/review-document.json",
    );

    const doc = JSON.parse(await readFile(docPath, "utf8"));
    doc.body.push({
      type: "component",
      name: "TraceQuote",
      props: { sessionId: "s1", event: 2 },
      children: [{ type: "text", value: "agent said so" }],
    });
    await writeFile(docPath, JSON.stringify(doc));

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

      expect(outcome.kind).toBe("imported");
      expect(outcome.kind === "imported" && outcome.warnings).toContain(
        "trace s1 unavailable; quoted as text",
      );
      const document = store.read(record.uuid).document;
      expect(JSON.stringify(document)).not.toContain(
        "Imported from the MDX review",
      );
      expect(document.at(-1)).toMatchObject({
        type: "markdown",
        markdown: "> agent said so\n",
      });
    } finally {
      await store.close();
    }
  });

  it("links a footnote's trace quote to the imported trace", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    await appendFootnoteTraceQuote(
      path.join(
        stored.dir,
        ".revisions",
        oids[0]!,
        ".bundle/document/review-document.json",
      ),
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => ({
          parserVersion: "1",
          descriptor: {
            sessionId: "s1",
            harness: "claude-code",
            available: true,
            source: null,
            commits: [],
          },
          trace: {
            harness: "claude-code",
            title: "Session",
            events: [
              { kind: "user", text: "why?" },
              { kind: "user", text: "and then?" },
              { kind: "assistant", markdown: "agent said so, plainly" },
            ],
            startedAt: null,
            endedAt: null,
            activeMs: null,
            userTurns: 2,
            toolCalls: 0,
          },
          subagents: [],
          traceName: null,
          cacheStatus: "current",
        }),
      });

      expect(outcome.kind).toBe("imported");
      expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);
      expect(store.read(record.uuid).document.at(-1)).toMatchObject({
        type: "markdown",
        markdown: expect.stringMatching(
          /\[\^1\]: The agent \[agent said so\]\(review-trace:[\da-f-]{36}#2\)\.\n$/,
        ),
      });
    } finally {
      await store.close();
    }
  });

  it("quotes a footnote's trace as text when the trace is gone", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-opencode-agentserver",
      repo,
    );

    await appendFootnoteTraceQuote(
      path.join(
        stored.dir,
        ".revisions",
        oids[0]!,
        ".bundle/document/review-document.json",
      ),
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

      expect(outcome.kind === "imported" && outcome.warnings).toContain(
        "trace s1 unavailable; quoted as text",
      );
      expect(store.read(record.uuid).document.at(-1)).toMatchObject({
        type: "markdown",
        markdown: expect.stringContaining("[^1]: The agent “agent said so”.\n"),
      });
    } finally {
      await store.close();
    }
  });

  it("resumes after a partial import and imports only the missing revisions", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 3 },
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const registered = await data.register(repo.root);
      await store.importVersions([
        {
          reviewId: record.uuid,
          title: "partial",
          pins: {
            repositoryId: registered.id,
            base: repo.base,
            head: repo.base,
          },
          document: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          origin: { revision: oids[0] },
        },
      ]);

      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

      expect(outcome).toMatchObject({ kind: "imported", version: 2 });
      expect(store.history(record.uuid).map((entry) => entry.version)).toEqual([
        0, 1, 2,
      ]);
      expect(store.read(record.uuid, 1).origin?.revision).toBe(oids[1]);
      expect(store.read(record.uuid, 2).origin?.revision).toBe(oids[2]);
    } finally {
      await store.close();
    }
  });

  it("reports an unresolved source range without adding document content", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    const docPath = path.join(
      stored.dir,
      ".revisions",
      oids[0]!,
      ".bundle/document/review-document.json",
    );

    const doc = JSON.parse(await readFile(docPath, "utf8"));
    doc.body.push({
      type: "element",
      tag: "p",
      props: {},
      children: [
        {
          type: "component",
          name: "AnchorLink",
          props: {
            anchor: {
              __kind: "db-anchor-ref",
              id: "gone",
              title: "Gone",
              peek: {
                side: "head",
                file: "missing.ts",
                fromLine: 1,
                toLine: 2,
              },
            },
          },
          children: [{ type: "text", value: "a vanished file" }],
        },
      ],
    });
    await writeFile(docPath, JSON.stringify(doc));

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    try {
      const outcome = await importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

      expect(outcome.kind).toBe("imported");
      expect(
        outcome.kind === "imported" && outcome.warnings.join("\n"),
      ).toContain("head/missing.ts#L1-L2");
      expect(JSON.stringify(store.read(record.uuid).document)).not.toContain(
        "Imported from the MDX review",
      );
    } finally {
      await store.close();
    }
  });

  it("does not re-import after a restore or a delete", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2 },
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    const run = () =>
      importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

    try {
      expect(await run()).toMatchObject({ kind: "imported", version: 1 });
      await store.execute({
        commandId: randomUUID(),
        operation: { type: "restore", reviewId: record.uuid, version: 0 },
      });
      expect(store.read(record.uuid).origin?.revision).toBe(oids[0]);
      expect(await run()).toEqual({ kind: "current", reviewId: record.uuid });
      expect(store.read(record.uuid).version).toBe(2);

      await store.execute({
        commandId: randomUUID(),
        operation: { type: "delete", reviewId: record.uuid },
      });
      expect(store.has(record.uuid)).toBe(false);
      expect(await run()).toEqual({ kind: "current", reviewId: record.uuid });
      expect(store.has(record.uuid)).toBe(false);
      expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
    } finally {
      await store.close();
    }
  });

  it("advances the cursor past revisions whose document did not change", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2, identical: true },
    );

    const { store, data } = openLocalReviewStore(
      path.join(home, "review-api.db"),
    );

    const run = () =>
      importLegacyReview({
        review: stored,
        store,
        data,
        materialize: materializeFromRevisionDirs,
        log: logFromRevisionDirs(oids),
        loadTrace: async () => null,
      });

    try {
      expect(await run()).toMatchObject({ kind: "imported", version: 0 });
      expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
      expect(await run()).toEqual({ kind: "current", reviewId: record.uuid });
      expect(store.read(record.uuid).version).toBe(0);
    } finally {
      await store.close();
    }
  });
});

/** Appends a paragraph whose footnote definition quotes a trace, the shape a
 * legacy review takes when an aside cites an agent session. */
async function appendFootnoteTraceQuote(docPath: string): Promise<void> {
  const doc = JSON.parse(await readFile(docPath, "utf8"));

  doc.body.push(
    {
      type: "element",
      tag: "p",
      props: {},
      children: [
        { type: "text", value: "Why" },
        {
          type: "element",
          tag: "sup",
          props: {},
          children: [
            {
              type: "element",
              tag: "a",
              props: {
                href: "#user-content-fn-1",
                id: "user-content-fnref-1",
                "data-footnote-ref": "true",
              },
              children: [{ type: "text", value: "1" }],
            },
          ],
        },
        { type: "text", value: "?" },
      ],
    },
    {
      type: "element",
      tag: "section",
      props: { "data-footnotes": "true" },
      children: [
        {
          type: "element",
          tag: "ol",
          props: {},
          children: [
            {
              type: "element",
              tag: "li",
              props: { id: "user-content-fn-1" },
              children: [
                {
                  type: "element",
                  tag: "p",
                  props: {},
                  children: [
                    { type: "text", value: "The agent " },
                    {
                      type: "component",
                      name: "TraceQuote",
                      props: { sessionId: "s1", event: 2 },
                      children: [{ type: "text", value: "agent said so" }],
                    },
                    { type: "text", value: "." },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );
  await writeFile(docPath, JSON.stringify(doc));
}
