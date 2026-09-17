import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { importLegacyReview } from "./import-review";
import {
  el,
  footnoteTraceQuoteSection,
  logFromRevisionDirs,
  materializeFromRevisionDirs,
  runImport,
  scratchGitRepo,
  syntheticLegacyReview,
  text,
} from "./import-test-utils";

describe("importLegacyReview", () => {
  it("imports every sealed revision as a version, oldest first", async () => {
    const { repo, record, oids, store, importReview } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 3 },
    );

    const outcome = await importReview();

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
    expect(await importReview()).toEqual({
      kind: "current",
      reviewId: record.uuid,
    });
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
    const { record, oids, store, documentPath, importReview } = await runImport(
      "schema4-bug-report-dialog",
    );

    await appendNodes(documentPath(oids[0]!), [
      {
        type: "component",
        name: "TraceQuote",
        props: { sessionId: "s1", event: 2 },
        children: [text("agent said so")],
      },
    ]);

    const outcome = await importReview();

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
  });

  it("links a footnote's trace quote to the imported trace", async () => {
    const { record, oids, store, documentPath, importReview } = await runImport(
      "schema4-bug-report-dialog",
      {
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
      },
    );

    await appendNodes(documentPath(oids[0]!), [
      el("p", [
        text("Why"),
        el("sup", [
          el("a", [text("1")], {
            href: "#user-content-fn-1",
            id: "user-content-fnref-1",
            "data-footnote-ref": "true",
          }),
        ]),
        text("?"),
      ]),
      footnoteTraceQuoteSection("1"),
    ]);

    const outcome = await importReview();

    expect(outcome.kind).toBe("imported");
    expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);
    expect(store.read(record.uuid).document.at(-1)).toMatchObject({
      type: "markdown",
      markdown: expect.stringMatching(
        /\[\^1\]: The agent \[agent said so\]\(review-trace:[\da-f-]{36}#2\)\.\n$/,
      ),
    });
  });

  it("resumes after a partial import and imports only the missing revisions", async () => {
    const { repo, record, oids, store, data, importReview } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 3 },
    );

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

    expect(await importReview()).toMatchObject({
      kind: "imported",
      version: 2,
    });
    expect(store.history(record.uuid).map((entry) => entry.version)).toEqual([
      0, 1, 2,
    ]);
    expect(store.read(record.uuid, 1).origin?.revision).toBe(oids[1]);
    expect(store.read(record.uuid, 2).origin?.revision).toBe(oids[2]);
  });

  it("reports an unresolved source range without adding document content", async () => {
    const { record, oids, store, documentPath, importReview } = await runImport(
      "schema4-bug-report-dialog",
    );

    await appendNodes(documentPath(oids[0]!), [
      el("p", [
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
          children: [text("a vanished file")],
        },
      ]),
    ]);

    const outcome = await importReview();

    expect(outcome.kind).toBe("imported");
    expect(
      outcome.kind === "imported" && outcome.warnings.join("\n"),
    ).toContain("head/missing.ts#L1-L2");
    expect(JSON.stringify(store.read(record.uuid).document)).not.toContain(
      "Imported from the MDX review",
    );
  });

  it("does not re-import after a restore or a delete", async () => {
    const { record, oids, store, importReview } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 2 },
    );

    expect(await importReview()).toMatchObject({
      kind: "imported",
      version: 1,
    });
    await store.execute({
      commandId: randomUUID(),
      operation: { type: "restore", reviewId: record.uuid, version: 0 },
    });
    expect(store.read(record.uuid).origin?.revision).toBe(oids[0]);
    expect(await importReview()).toEqual({
      kind: "current",
      reviewId: record.uuid,
    });
    expect(store.read(record.uuid).version).toBe(2);

    await store.execute({
      commandId: randomUUID(),
      operation: { type: "delete", reviewId: record.uuid },
    });
    expect(store.has(record.uuid)).toBe(false);
    expect(await importReview()).toEqual({
      kind: "current",
      reviewId: record.uuid,
    });
    expect(store.has(record.uuid)).toBe(false);
    expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
  });

  it("advances the cursor past revisions whose document did not change", async () => {
    const { record, oids, store, importReview } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 2, identical: true },
    );

    expect(await importReview()).toMatchObject({
      kind: "imported",
      version: 0,
    });
    expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
    expect(await importReview()).toEqual({
      kind: "current",
      reviewId: record.uuid,
    });
    expect(store.read(record.uuid).version).toBe(0);
  });
});

/** Appends nodes to a sealed document, the way a legacy review carried shapes
 * the fixtures do not. */
async function appendNodes(docPath: string, nodes: unknown[]): Promise<void> {
  const doc = JSON.parse(await readFile(docPath, "utf8"));

  doc.body.push(...nodes);
  await writeFile(docPath, JSON.stringify(doc));
}
