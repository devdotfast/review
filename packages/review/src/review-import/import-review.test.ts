import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
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

  it("stores a published image once for every revision that shows it", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2, assets: { "shots/flow.png": await square("red") } },
    );

    for (const oid of oids) {
      await appendImage(documentPath(stored.dir, oid), {
        src: "./shots/flow.png",
        alt: "The flow",
      });
      await appendImage(documentPath(stored.dir, oid), {
        src: "/shots/flow.png",
        alt: "The flow again",
      });
    }

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

      expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);

      const images = store.read(record.uuid).document.slice(-2);

      expect(images).toMatchObject([
        { type: "image", alt: "The flow" },
        { type: "image", alt: "The flow again" },
      ]);

      const assetId = images[0]!.type === "image" ? images[0].assetId : "";

      // A root-relative source addresses the review directory, and one file is
      // one resource however it was addressed or however often republished.
      expect(images[1]).toMatchObject({ assetId });
      expect(store.read(record.uuid, 0).document.at(-1)).toMatchObject({
        assetId,
      });

      const resource = store.resource(assetId);

      expect(resource.mimeType).toBe("image/png");
      expect((await sharp(Buffer.from(resource.data)).metadata()).width).toBe(
        2,
      );
    } finally {
      await store.close();
    }
  });

  it("stores an image edited between revisions as a second resource", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2, assets: { "shots/flow.png": await square("red") } },
    );

    for (const oid of oids)
      await appendImage(documentPath(stored.dir, oid), {
        src: "./shots/flow.png",
        alt: "The flow",
      });
    // The second revision republished the screenshot with new content.
    await writeFile(
      path.join(stored.dir, ".revisions", oids[1]!, "shots/flow.png"),
      await square("blue"),
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

      expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);

      const first = store.read(record.uuid, 0).document.at(-1)!;
      const second = store.read(record.uuid).document.at(-1)!;

      const assetId = (block: typeof first) =>
        block.type === "image" ? block.assetId : "";

      expect(assetId(first)).not.toBe(assetId(second));
      // Each version keeps the image it was published with.
      expect(
        Buffer.from(store.resource(assetId(first)).data).equals(
          store.resource(assetId(second)).data,
        ),
      ).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("keeps the alt text of an image it cannot read", async () => {
    const repo = await scratchGitRepo();

    const { home, record, stored, oids } = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    await appendImage(documentPath(stored.dir, oids[0]!), {
      src: "gone.png",
      alt: "Missing shot",
    });
    await appendImage(documentPath(stored.dir, oids[0]!), {
      src: "../../order.ts",
      alt: "Escaping shot",
    });

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

      const warnings = outcome.kind === "imported" ? outcome.warnings : [];
      expect(warnings).toEqual([
        expect.stringContaining('image "gone.png" could not be imported'),
        expect.stringContaining(
          'image "../../order.ts" could not be imported: outside the review',
        ),
      ]);
      expect(store.read(record.uuid).document.slice(-2)).toMatchObject([
        { type: "markdown", markdown: "*Missing shot*\n" },
        { type: "markdown", markdown: "*Escaping shot*\n" },
      ]);
    } finally {
      await store.close();
    }
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

  it("recovers a deleted checkout only from a candidate containing the pinned commits", async () => {
    const repo = await scratchGitRepo();

    const fixture = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      {
        overrides: { worktreePath: path.join(repo.root, "removed-workspace") },
      },
    );

    const { store, data } = openLocalReviewStore(
      path.join(fixture.home, "api.db"),
    );

    try {
      expect(
        await importLegacyReview({
          review: fixture.stored,
          store,
          data,
          repositoryPaths: [repo.root],
          materialize: materializeFromRevisionDirs,
          log: logFromRevisionDirs(fixture.oids),
          loadTrace: async () => null,
        }),
      ).toMatchObject({ kind: "imported" });
      expect(store.read(fixture.record.uuid).pins).toMatchObject({
        base: repo.base,
        head: repo.head,
      });
      expect(
        JSON.parse(
          await readFile(path.join(fixture.dir, "review.json"), "utf8"),
        ).worktreePath,
      ).toBe(path.join(repo.root, "removed-workspace"));
    } finally {
      await data.close();
      await store.close();
    }
  });

  it("backfills missing publications without replacing JSON edits or existing version IDs", async () => {
    const repo = await scratchGitRepo();

    const fixture = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2 },
    );

    const { store, data } = openLocalReviewStore(
      path.join(fixture.home, "api.db"),
    );

    const input = {
      review: fixture.stored,
      store,
      data,
      materialize: materializeFromRevisionDirs,
      loadTrace: async () => null,
    };

    try {
      await importLegacyReview({
        ...input,
        log: logFromRevisionDirs([fixture.oids[1]!]),
      });
      const original = store.read(fixture.record.uuid, 0);
      await store.execute({
        commandId: randomUUID(),
        operation: {
          type: "edit",
          reviewId: fixture.record.uuid,
          edit: {
            type: "insert",
            content: {
              type: "markdown",
              markdown: "An edit made after migration.",
            },
          },
        },
      });
      const edited = store.read(fixture.record.uuid);

      const complete = {
        ...input,
        completeHistory: true,
        log: logFromRevisionDirs(fixture.oids),
      };

      await importLegacyReview(complete);
      const current = store.read(fixture.record.uuid);
      expect(current.document).toEqual(edited.document);
      expect(current.pins).toEqual(edited.pins);
      expect(current.createdAt).toEqual(edited.createdAt);
      expect(store.read(fixture.record.uuid, 0)).toEqual(original);

      const recovered = store
        .history(fixture.record.uuid)
        .map((v) => store.read(fixture.record.uuid, v.version))
        .find((v) => v.origin?.revision === fixture.oids[0]);

      expect(recovered?.pins.head).toBe(repo.base);
      expect(await importLegacyReview(complete)).toMatchObject({
        kind: "current",
      });
      expect(store.read(fixture.record.uuid).version).toBe(current.version);
    } finally {
      await data.close();
      await store.close();
    }
  });

  it("repairs imported section headings once while preserving edits and history", async () => {
    const repo = await scratchGitRepo();

    const fixture = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    const sealed = {
      format: "review-document/1",
      title: "Copy",
      routePath: "/",
      sourcePath: "review.mdx",
      anchors: {},
      anchorContents: {},
      softwareModels: [],
      body: [
        {
          type: "component",
          name: "ReviewSection",
          props: { title: "Copy" },
          children: [
            {
              type: "element",
              tag: "h2",
              props: {},
              children: [{ type: "text", value: "Copy" }],
            },
            {
              type: "element",
              tag: "p",
              props: {},
              children: [{ type: "text", value: "Original prose." }],
            },
          ],
        },
      ],
    };

    await writeFile(
      path.join(
        fixture.dir,
        ".revisions",
        fixture.oids[0]!,
        ".bundle/document/review-document.json",
      ),
      JSON.stringify(sealed),
    );

    const { store, data } = openLocalReviewStore(
      path.join(fixture.home, "api.db"),
    );

    const input = {
      review: fixture.stored,
      store,
      data,
      materialize: materializeFromRevisionDirs,
      log: logFromRevisionDirs(fixture.oids),
    };

    try {
      await importLegacyReview(input);
      const clean = store.read(fixture.record.uuid);
      expect(clean.document).toMatchObject([
        {
          type: "section",
          title: "Copy",
          children: [{ type: "markdown", markdown: "Original prose.\n" }],
        },
      ]);
      // Reproduce a version written by the old importer, plus later user edits.
      await store.importVersions([
        {
          ...clean,
          document: [
            {
              type: "section",
              title: "Copy",
              children: [
                { type: "markdown", markdown: "## Copy\n\nEdited prose.\n" },
                {
                  type: "markdown",
                  markdown: "## An intentional subheading\n",
                },
              ],
            },
            {
              type: "section",
              title: "Copy",
              children: [
                {
                  type: "markdown",
                  markdown: "## User changed this heading\n\nKeep me.\n",
                },
              ],
            },
          ],
        },
      ]);
      const before = store.read(fixture.record.uuid);
      const expected = structuredClone(before.document);
      const first = expected[0];

      if (first?.type !== "section" || first.children[0]?.type !== "markdown")
        throw new Error("Missing imported prose");
      first.children[0].markdown = "Edited prose.\n";
      await importLegacyReview({ ...input, completeHistory: true });
      const after = store.read(fixture.record.uuid);
      expect(after).toEqual({
        ...before,
        version: before.version + 1,
        document: expected,
      });
      expect(store.read(fixture.record.uuid, before.version)).toEqual(before);
      expect(
        await importLegacyReview({ ...input, completeHistory: true }),
      ).toMatchObject({ kind: "current" });
      expect(store.read(fixture.record.uuid)).toEqual(after);
    } finally {
      await data.close();
      await store.close();
    }
  });

  it("advances the cursor past revisions whose document did not change", async () => {
    const { record, oids, stored, store, importReview } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 2, identical: true },
    );

    // Both the prose and its source pins are identical in this publication.
    await writeFile(
      path.join(stored.dir, ".revisions", oids[0]!, "review.json"),
      JSON.stringify({ ...record, presentedDocumentRevision: oids[0] }),
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

const square = (background: string) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background } })
    .png()
    .toBuffer();

const documentPath = (dir: string, oid: string) =>
  path.join(dir, ".revisions", oid, ".bundle/document/review-document.json");

/** Appends a paragraph holding one image, the shape a legacy review takes when
 * it shows a screenshot published beside its document. */
async function appendImage(
  docPath: string,
  props: { src: string; alt: string },
): Promise<void> {
  const doc = JSON.parse(await readFile(docPath, "utf8"));

  doc.body.push({
    type: "element",
    tag: "p",
    props: {},
    children: [{ type: "element", tag: "img", props, children: [] }],
  });
  await writeFile(docPath, JSON.stringify(doc));
}

/** Appends nodes to a sealed document, the way a legacy review carried shapes
 * the fixtures do not. */
async function appendNodes(docPath: string, nodes: unknown[]): Promise<void> {
  const doc = JSON.parse(await readFile(docPath, "utf8"));

  doc.body.push(...nodes);
  await writeFile(docPath, JSON.stringify(doc));
}
