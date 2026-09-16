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
      });
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

  it("quotes a trace as text and surfaces the warning in a callout", async () => {
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

      expect(outcome).toMatchObject({
        kind: "imported",
        warnings: ["trace s1 unavailable; quoted as text"],
      });
      const document = store.read(record.uuid).document;
      expect(document[0]).toMatchObject({
        type: "callout",
        tone: "warning",
        title: "Imported from the MDX review",
      });
      expect(document.at(-1)).toMatchObject({
        type: "markdown",
        markdown: "> agent said so\n",
      });
    } finally {
      await store.close();
    }
  });
});
