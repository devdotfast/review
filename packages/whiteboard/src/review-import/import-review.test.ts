import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { selectSource } from "../lens-selection";
import type { Block } from "../session-api/document";
import { openLocalSessionStore } from "../session-api/local-data";
import { importLegacyWhiteboard, isMapSection } from "./import-review";
import {
  el,
  footnoteTraceQuoteSection,
  logFromRevisionDirs,
  materializeFromRevisionDirs,
  runImport,
  scratchGitRepo,
  sealLegacyMapRevision,
  syntheticLegacyWhiteboard,
  text,
} from "./import-test-utils";

describe("importLegacyWhiteboard", () => {
  it("imports every sealed revision as a version, oldest first", async () => {
    const { repo, record, oids, store, importWhiteboard } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 3 },
    );

    const outcome = await importWhiteboard();

    expect(outcome).toMatchObject({
      kind: "imported",
      sessionId: record.uuid,
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
    expect(store.read(record.uuid, 0).pins!.head).toBe(repo.base);
    expect(store.read(record.uuid, 2).pins!.head).toBe(repo.head);
    expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);
    expect(await importWhiteboard()).toEqual({
      kind: "current",
      sessionId: record.uuid,
    });
  });

  it("skips system, never-published and repository-less reviews", async () => {
    const repo = await scratchGitRepo();

    const system = await syntheticLegacyWhiteboard(
      "schema4-bug-report-dialog",
      repo,
      { overrides: { visibility: "system" } },
    );

    const never = await syntheticLegacyWhiteboard(
      "schema4-bug-report-dialog",
      repo,
      { overrides: { presentedDocumentRevision: null } },
    );

    const gone = await syntheticLegacyWhiteboard(
      "schema4-opencode-agentserver",
      repo,
      { overrides: { worktreePath: path.join(repo.root, "missing") } },
    );

    const { store, data } = openLocalSessionStore(
      path.join(system.home, "review-api.db"),
    );

    try {
      const outcomes = [];

      for (const fixture of [system, never, gone])
        outcomes.push(
          await importLegacyWhiteboard({
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
          sessionId: system.record.uuid,
          reason: "system review",
        },
        {
          kind: "skipped",
          sessionId: never.record.uuid,
          reason: "never published",
        },
        {
          kind: "skipped",
          sessionId: gone.record.uuid,
          reason: `repository unavailable at ${path.join(repo.root, "missing")}`,
        },
      ]);
      expect(store.has(never.record.uuid)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("preserves unavailable quotes and reports import warnings outside the document", async () => {
    const { record, oids, store, documentPath, importWhiteboard } =
      await runImport("schema4-bug-report-dialog");

    await appendNodes(documentPath(oids[0]!), [
      {
        type: "component",
        name: "TraceQuote",
        props: { sessionId: "s1", event: 2 },
        children: [text("agent said so")],
      },
    ]);

    const outcome = await importWhiteboard();

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
    const { record, oids, store, documentPath, importWhiteboard } =
      await runImport("schema4-bug-report-dialog", {
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

    const outcome = await importWhiteboard();

    expect(outcome.kind).toBe("imported");
    expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);
    expect(store.read(record.uuid).document.at(-1)).toMatchObject({
      type: "markdown",
      markdown: expect.stringMatching(
        /\[\^1\]: The agent \[agent said so\]\(whiteboard-trace:[\da-f-]{36}#2\)\.\n$/,
      ),
    });
  });

  it("stores a published image once per file, keeping what each version showed", async () => {
    const { dir, record, oids, store, documentPath, importWhiteboard } =
      await runImport("schema4-bug-report-dialog", {
        revisions: 2,
        assets: {
          "shots/flow.png": await square("red"),
          "shots/edit.png": await square("green"),
        },
      });

    for (const oid of oids)
      await appendNodes(documentPath(oid), [
        el("p", [el("img", [], { src: "./shots/flow.png", alt: "The flow" })]),
        el("p", [
          el("img", [], { src: "/shots/flow.png", alt: "The flow again" }),
        ]),
        el("p", [el("img", [], { src: "./shots/edit.png", alt: "The edit" })]),
      ]);

    // The second revision republished one of the screenshots with new content.
    await writeFile(
      path.join(dir, ".revisions", oids[1]!, "shots/edit.png"),
      await square("blue"),
    );

    const outcome = await importWhiteboard();

    expect(outcome.kind === "imported" && outcome.warnings).toEqual([]);

    const first = store.read(record.uuid, 0).document.slice(-3);
    const second = store.read(record.uuid).document.slice(-3);

    expect(second).toMatchObject([
      { type: "image", alt: "The flow" },
      { type: "image", alt: "The flow again" },
      { type: "image", alt: "The edit" },
    ]);
    // A root-relative source addresses the review directory, and one file is
    // one resource however it was addressed or however often republished.
    expect(assetId(second, 0)).toBe(assetId(second, 1));
    expect(assetId(first, 0)).toBe(assetId(second, 0));
    // The edited screenshot is a second resource, so each version keeps the
    // image it was published with.
    expect(assetId(first, 2)).not.toBe(assetId(second, 2));

    const resource = store.resource(assetId(second, 2));

    expect(resource.mimeType).toBe("image/png");
    expect((await sharp(Buffer.from(resource.data)).metadata()).width).toBe(2);
  });

  it("keeps the alt text of an image it cannot read", async () => {
    const { record, oids, store, documentPath, importWhiteboard } =
      await runImport("schema4-bug-report-dialog");

    await appendNodes(documentPath(oids[0]!), [
      el("p", [el("img", [], { src: "gone.png", alt: "Missing shot" })]),
      el("p", [
        el("img", [], { src: "../../order.ts", alt: "Escaping *shot* [1]" }),
      ]),
    ]);

    const outcome = await importWhiteboard();
    const warnings = outcome.kind === "imported" ? outcome.warnings : [];

    expect(warnings).toEqual([
      expect.stringContaining('image "gone.png" could not be imported'),
      expect.stringContaining(
        'image "../../order.ts" could not be imported: outside the review',
      ),
    ]);
    expect(store.read(record.uuid).document.slice(-2)).toMatchObject([
      { type: "markdown", markdown: "*Missing shot*\n" },
      { type: "markdown", markdown: "*Escaping \\*shot\\* \\[1\\]*\n" },
    ]);
  });

  it("resumes after a partial import and imports only the missing revisions", async () => {
    const { repo, record, oids, store, data, importWhiteboard } =
      await runImport("schema4-bug-report-dialog", { revisions: 3 });

    const registered = await data.register(repo.root);

    await store.importVersions([
      {
        sessionId: record.uuid,
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

    expect(await importWhiteboard()).toMatchObject({
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
    const { record, oids, store, documentPath, importWhiteboard } =
      await runImport("schema4-bug-report-dialog");

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
              peek: selectSource({
                side: "head",
                file: "missing.ts",
                fromLine: 1,
                toLine: 2,
              }),
            },
          },
          children: [text("a vanished file")],
        },
      ]),
    ]);

    const outcome = await importWhiteboard();

    expect(outcome.kind).toBe("imported");
    expect(
      outcome.kind === "imported" && outcome.warnings.join("\n"),
    ).toContain("head/missing.ts#L1-L2");
    expect(JSON.stringify(store.read(record.uuid).document)).not.toContain(
      "Imported from the MDX review",
    );
  });

  it("does not re-import after a restore or a delete", async () => {
    const { record, oids, store, importWhiteboard } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 2 },
    );

    expect(await importWhiteboard()).toMatchObject({
      kind: "imported",
      version: 1,
    });
    await store.execute({
      commandId: randomUUID(),
      operation: { type: "restore", sessionId: record.uuid, version: 0 },
    });
    expect(store.read(record.uuid).origin?.revision).toBe(oids[0]);
    expect(await importWhiteboard()).toEqual({
      kind: "current",
      sessionId: record.uuid,
    });
    expect(store.read(record.uuid).version).toBe(2);

    await store.execute({
      commandId: randomUUID(),
      operation: { type: "delete", sessionId: record.uuid },
    });
    expect(store.has(record.uuid)).toBe(false);
    expect(await importWhiteboard()).toEqual({
      kind: "current",
      sessionId: record.uuid,
    });
    expect(store.has(record.uuid)).toBe(false);
    expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
  });

  it("recovers a deleted checkout only from a candidate containing the pinned commits", async () => {
    const repo = await scratchGitRepo();

    const fixture = await syntheticLegacyWhiteboard(
      "schema4-bug-report-dialog",
      repo,
      {
        overrides: { worktreePath: path.join(repo.root, "removed-workspace") },
      },
    );

    const { store, data } = openLocalSessionStore(
      path.join(fixture.home, "api.db"),
    );

    try {
      expect(
        await importLegacyWhiteboard({
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

    const fixture = await syntheticLegacyWhiteboard(
      "schema4-bug-report-dialog",
      repo,
      { revisions: 2 },
    );

    const { store, data } = openLocalSessionStore(
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
      await importLegacyWhiteboard({
        ...input,
        log: logFromRevisionDirs([fixture.oids[1]!]),
      });
      const original = store.read(fixture.record.uuid, 0);
      await store.execute({
        commandId: randomUUID(),
        operation: {
          type: "edit",
          sessionId: fixture.record.uuid,
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

      await importLegacyWhiteboard(complete);
      const current = store.read(fixture.record.uuid);
      expect(current.document).toEqual(edited.document);
      expect(current.pins).toEqual(edited.pins);
      expect(current.createdAt).toEqual(edited.createdAt);
      expect(store.read(fixture.record.uuid, 0)).toEqual(original);

      const recovered = store
        .history(fixture.record.uuid)
        .map((v) => store.read(fixture.record.uuid, v.version))
        .find((v) => v.origin?.revision === fixture.oids[0]);

      expect(recovered?.pins!.head).toBe(repo.base);
      expect(await importLegacyWhiteboard(complete)).toMatchObject({
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

    const fixture = await syntheticLegacyWhiteboard(
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
          name: "WhiteboardSection",
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

    const { store, data } = openLocalSessionStore(
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
      await importLegacyWhiteboard(input);
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
          pins: clean.pins!,
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
      await importLegacyWhiteboard({ ...input, completeHistory: true });
      const after = store.read(fixture.record.uuid);
      expect(after).toEqual({
        ...before,
        version: before.version + 1,
        document: expected,
      });
      expect(store.read(fixture.record.uuid, before.version)).toEqual(before);
      expect(
        await importLegacyWhiteboard({ ...input, completeHistory: true }),
      ).toMatchObject({ kind: "current" });
      expect(store.read(fixture.record.uuid)).toEqual(after);
    } finally {
      await data.close();
      await store.close();
    }
  });

  it("advances the cursor past revisions whose document did not change", async () => {
    const { record, oids, stored, store, importWhiteboard } = await runImport(
      "schema4-bug-report-dialog",
      { revisions: 2, identical: true },
    );

    // Both the prose and its source pins are identical in this publication.
    await writeFile(
      path.join(stored.dir, ".revisions", oids[0]!, "review.json"),
      JSON.stringify({ ...record, presentedDocumentRevision: oids[0] }),
    );

    expect(await importWhiteboard()).toMatchObject({
      kind: "imported",
      version: 0,
    });
    expect(store.legacyImport(record.uuid)?.revision).toBe(oids[1]);
    expect(await importWhiteboard()).toEqual({
      kind: "current",
      sessionId: record.uuid,
    });
    expect(store.read(record.uuid).version).toBe(0);
  });

  it("imports a later map publish into the section it already wrote", async () => {
    const { repo, dir, record, store, importWhiteboard } = await runImport(
      "schema4-opencode-agentserver",
      { map: { oid: mapOids[0] } },
    );

    expect(await importWhiteboard()).toMatchObject({
      kind: "imported",
      version: 0,
    });

    const [published] = mapSections(store.read(record.uuid).document);

    expect(store.legacyImport(record.uuid)?.mapRevision).toBe(mapOids[0]);

    // A reader annotates the review between the two map publishes.
    const note = await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        sessionId: record.uuid,
        edit: {
          type: "insert",
          content: { type: "markdown", markdown: "Mine.\n" },
        },
      },
    });

    await sealLegacyMapRevision(dir, mapOids[1]!, {
      headCommit: repo.head,
      baseCommit: repo.base,
    });

    const republished = {
      dir,
      review: { ...record, presentedSoftwareMapRevision: mapOids[1]! },
    };

    expect(await importWhiteboard(republished)).toMatchObject({
      kind: "imported",
      version: 2,
    });

    const document = store.read(record.uuid).document;
    const sections = mapSections(document);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe(published!.id);
    expect(sections[0]!.mapVersionIds).not.toEqual(published!.mapVersionIds);
    expect(document.some((block) => block.id === note.targetId)).toBe(true);
    expect(store.legacyImport(record.uuid)?.mapRevision).toBe(mapOids[1]);
    expect(await importWhiteboard(republished)).toEqual({
      kind: "current",
      sessionId: record.uuid,
    });
  });

  it("retries a map bundle sealed against other commits", async () => {
    const { repo, dir, record, store, importWhiteboard } = await runImport(
      "schema4-opencode-agentserver",
      {
        map: {
          oid: mapOids[0]!,
          headCommit: "c".repeat(40),
          baseCommit: "d".repeat(40),
        },
      },
    );

    const first = await importWhiteboard();

    // The document must not sink with the map it could not show.
    expect(first).toMatchObject({ kind: "imported", version: 0 });
    expect(first.kind === "imported" && first.warnings.join("\n")).toContain(
      mapOids[0]!,
    );
    expect(mapSections(store.read(record.uuid).document)).toEqual([]);
    expect(store.legacyImport(record.uuid)?.mapRevision).toBeNull();

    // Still failing: the open path must not read this as a skipped review.
    expect(await importWhiteboard()).toMatchObject({
      kind: "current",
      warnings: [expect.stringContaining(mapOids[0]!)],
    });
    expect(store.read(record.uuid).version).toBe(0);

    await sealLegacyMapRevision(dir, mapOids[0]!, {
      headCommit: repo.head,
      baseCommit: repo.base,
    });
    expect(await importWhiteboard()).toMatchObject({
      kind: "imported",
      version: 1,
    });
    expect(mapSections(store.read(record.uuid).document)).toHaveLength(1);
    expect(store.legacyImport(record.uuid)?.mapRevision).toBe(mapOids[0]);
  });

  it("leaves a deleted review deleted when only its map moved on", async () => {
    const { dir, record, store, importWhiteboard } = await runImport(
      "schema4-opencode-agentserver",
      { map: { oid: mapOids[0] } },
    );

    expect(await importWhiteboard()).toMatchObject({ kind: "imported" });
    await store.execute({
      commandId: randomUUID(),
      operation: { type: "delete", sessionId: record.uuid },
    });

    expect(
      await importWhiteboard({
        dir,
        review: { ...record, presentedSoftwareMapRevision: mapOids[1]! },
      }),
    ).toEqual({ kind: "current", sessionId: record.uuid });
    expect(store.has(record.uuid)).toBe(false);
  });
});

const mapOids = ["a".repeat(40), "b".repeat(40)];

/** The map sections of a document, as the maps they show. */
const mapSections = (document: Block[]) =>
  document.flatMap((block) =>
    isMapSection(block)
      ? [
          {
            id: block.id,
            mapVersionIds: block.children.map((child) =>
              child.type === "software_map" ? child.mapVersionId : "",
            ),
          },
        ]
      : [],
  );

const square = (background: string) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background } })
    .png()
    .toBuffer();

const assetId = (blocks: Block[], index: number) => {
  const block = blocks[index];

  return block?.type === "image" ? block.assetId : "";
};

/** Appends nodes to a sealed document, the way a legacy review carried shapes
 * the fixtures do not. */
async function appendNodes(docPath: string, nodes: unknown[]): Promise<void> {
  const doc = JSON.parse(await readFile(docPath, "utf8"));

  doc.body.push(...nodes);
  await writeFile(docPath, JSON.stringify(doc));
}
