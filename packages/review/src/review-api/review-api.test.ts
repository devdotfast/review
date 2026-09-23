import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { selectSource } from "../lens-selection.js";
import { createGlobalReviewServer } from "../server/desktop-server.js";
import { GlobalReviewDesktopVerbRelay } from "../server/global-verb-relay.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import { ReviewApiClient } from "./client.js";
import { documentText } from "./document-text.js";
import { ReviewInputError } from "./document.js";
import { LocalReviewData } from "./local-data";
import {
  type ReviewProviders,
  ReviewStore,
  SCRATCHPAD_ID,
  inspectSnapshot,
} from "./store.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const source = {
  side: "head" as const,
  file: "src/store.ts",
  fromLine: 1,
  toLine: 5,
};

const diagram = {
  type: "sequence",
  title: "Save",
  actors: { app: "App", db: "Database" },
  steps: [
    { from: "app", to: "db", label: "Write", source: selectSource(source) },
  ],
};

let directory: string, database: string, store: ReviewStore;

let providers: ReviewProviders;

const request = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const create = () =>
  store.execute(request({ type: "create", title: "Example", pins }));

const edit = <Content>(reviewId: string, value: Content) =>
  store.execute(request({ type: "edit", reviewId, edit: value }));

const writeLens = <Edit>(reviewId: string, value: Edit, leaseId?: string) =>
  store.execute({
    ...request({ type: "lens", reviewId, edit: value }),
    leaseId,
  });

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-lean-"));
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  providers = {
    validatePins: vi.fn<ReviewProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<ReviewProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<ReviewProviders["validateResource"]>(
      async () => {},
    ),
  };
  store = new ReviewStore(database, providers);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("snapshot authoring", () => {
  it("binds PR identity without erasing content, versions changes, and clears stale identity across repositories", async () => {
    const url = "https://github.com/devdotfast/review/pull/310";

    const { reviewId } = await store.execute(
      request({
        type: "create",
        title: "PR review",
        pins,
        pullRequestUrl: url,
      }),
    );

    expect(store.list()[0]?.origin).toEqual({
      pullRequestNumber: 310,
      pullRequestUrl: url,
    });
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep this analysis" },
    });
    const authored = store.read(reviewId);

    const rebinding = request({
      type: "repin",
      pins,
      reviewId,
      pullRequestUrl: "https://github.com/devdotfast/review/pull/311",
    });

    const bound = await store.execute(rebinding);
    expect(await store.execute(rebinding)).toEqual(bound);
    expect(store.read(reviewId).document).toEqual(authored.document);
    expect(store.read(reviewId).pins).toEqual(pins);
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(311);
    expect(
      store.read(reviewId, authored.version).origin?.pullRequestNumber,
    ).toBe(310);
    await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(311);
    await store.execute(
      request({
        type: "repin",
        reviewId,
        pins: { ...pins, repositoryId: "other-repository" },
      }),
    );
    expect(store.read(reviewId).origin?.pullRequestUrl).toBeUndefined();
    await store.execute(
      request({ type: "restore", reviewId, version: authored.version }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(310);
    expect(store.read(reviewId).document).toEqual(authored.document);
    await store.execute(
      request({ type: "repin", reviewId, pins, pullRequestUrl: null }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBeUndefined();
    expect(store.read(reviewId).document).toEqual(authored.document);
  });

  it("preserves imported provenance when attaching a PR and supports explicit repin identity", async () => {
    const { reviewId } = await create();
    await store.importVersion({
      reviewId,
      title: "Imported",
      pins,
      document: [],
      createdAt: new Date().toISOString(),
      origin: {
        branch: "feature",
        baseRef: "main",
        revision: "legacy-revision",
      },
    });
    await store.execute(
      request({
        type: "repin",
        reviewId,
        pins,
        pullRequestUrl: "https://github.com/devdotfast/review/pull/319",
      }),
    );
    expect(store.read(reviewId).origin).toEqual({
      branch: "feature",
      baseRef: "main",
      revision: "legacy-revision",
      pullRequestNumber: 319,
      pullRequestUrl: "https://github.com/devdotfast/review/pull/319",
    });
    await store.execute(
      request({ type: "repin", reviewId, pins, pullRequestUrl: null }),
    );
    expect(store.read(reviewId).origin).toEqual({
      branch: "feature",
      baseRef: "main",
      revision: "legacy-revision",
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/999999999999999999999",
    "https://github.com/owner/repo/pull/1#discussion",
  ])("rejects invalid PR identity %s before writing", async (url) => {
    expect(() =>
      store.execute(
        request({
          type: "create",
          title: "Bad identity",
          pins,
          pullRequestUrl: url,
        }),
      ),
    ).toThrow(/canonical GitHub PR URL|PR number is too large/);
    expect(store.list()).toEqual([]);
  });

  it("compares execution paths in the same snapshot without changing their source pins", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: {
        type: "call_stack_diff",
        title: "Mouse versus keyboard",
        base: [
          {
            key: "mouse",
            label: "selectionchange",
            source: selectSource(source),
          },
        ],
        head: [
          { key: "keyboard", label: "keydown", source: selectSource(source) },
        ],
      },
    });
    const saved = store.read(reviewId).document[0]!;
    expect(saved).toMatchObject({
      type: "call_stack_diff",
      base: [{ source: selectSource(source) }],
      head: [{ source: selectSource(source) }],
    });
    expect(providers.validateSource).toHaveBeenCalledWith(pins, source, {
      peek: true,
    });
  });

  it("deletes one review and its history, keeps other reviews, and cannot replay deleted content", async () => {
    const input = request({ type: "create", title: "Delete me", pins });
    const { reviewId } = await store.execute(input);
    const other = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Private review text" },
    });
    const deletion = request({ type: "delete", reviewId });
    const result = await store.execute(deletion);
    expect(result).toMatchObject({ reviewId, deleted: true });
    expect(await store.execute(deletion)).toEqual(result);
    expect(() => store.read(reviewId)).toThrow(/not found/);
    expect(store.history(reviewId)).toEqual([]);
    expect(store.read(other.reviewId)).toMatchObject({
      version: 0,
      title: "Example",
    });
    await store.close();
    store = new ReviewStore(database, providers);
    expect(store.list().map((review) => review.reviewId)).toEqual([
      other.reviewId,
    ]);
    await expect(store.execute(input)).rejects.toThrow(/was deleted/);
    expect(await store.execute(deletion)).toEqual(result);
  });
  it("persists attention without creating a document version or notifying its readers", async () => {
    const { reviewId } = await create();
    const other = await create();
    const document = store.read(reviewId);

    const documents = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>(),
      catalog = vi.fn<() => void>();

    store.subscribe(documents);
    store.subscribeCatalog(catalog);
    const dismiss = request({ type: "attention", reviewId, action: "dismiss" });
    const result = await store.execute(dismiss);
    await store.execute(dismiss);
    await store.execute(
      request({ type: "attention", reviewId, action: "view" }),
    );
    expect(result).toMatchObject({ version: 0, attention: true });
    expect(documents).not.toHaveBeenCalled();
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(store.read(reviewId)).toEqual(document);
    expect(store.history(reviewId)).toHaveLength(1);
    await store.close();
    store = new ReviewStore(database, providers);
    expect(
      store.list().find((review) => review.reviewId === reviewId),
    ).toMatchObject({
      viewedAt: expect.any(String),
      dismissedAt: expect.any(String),
    });
    expect(
      store.list().find((review) => review.reviewId === other.reviewId),
    ).toMatchObject({
      viewedAt: null,
      dismissedAt: null,
    });
    await store.execute(
      request({ type: "attention", reviewId, action: "restore" }),
    );
    expect(
      store.list().find((review) => review.reviewId === reviewId)?.dismissedAt,
    ).toBeNull();
  });

  it.each([
    { type: "markdown", markdown: "# Summary\n**Ordinary Markdown**" },
    { type: "code", language: "ts", text: "const value = 1" },
    { type: "divider" },
    {
      type: "section",
      title: "Details",
      children: [{ type: "markdown", markdown: "Nested" }],
    },
    { type: "callout", tone: "warning", children: [] },
    { type: "code_peek", source: selectSource(source) },
    diagram,
    {
      type: "call_stack_diff",
      title: "Change",
      base: [{ source: selectSource({ ...source, side: "base" }) }],
      head: [{ source: selectSource(source) }],
    },
    {
      type: "database_lens",
      title: "Storage",
      actors: { app: "App" },
      stores: {
        db: {
          label: "Database",
          storage: "relational",
          collections: {
            reviews: {
              label: "Reviews",
              fields: { id: { label: "ID", dataType: "text" } },
            },
          },
        },
      },
      useCases: [
        {
          label: "Save",
          operations: [
            {
              kind: "write",
              store: "db",
              collection: "reviews",
              actor: "app",
              label: "Insert",
              source: selectSource(source),
            },
          ],
        },
      ],
    },
    { type: "image", assetId: "image-1", alt: "Example" },
    {
      type: "trace_quote",
      traceId: "trace-1",
      eventId: "event-1",
      text: "Keep it simple",
    },
    { type: "software_map", mapVersionId: "map-1" },
  ])(
    "saves and reads a $type component without a second document representation",
    async (content) => {
      const { reviewId } = await create();
      const result = await edit(reviewId, { type: "insert", content });
      expect(store.inspect(reviewId, result.targetId)).toMatchObject({
        ...content,
        id: result.targetId,
      });
      expect(store.inspect(reviewId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: result.targetId, type: content.type }),
        ]),
      );
    },
  );

  it("keeps reviews isolated and history readable across restart, deletion, restore and new pins", async () => {
    const first = await create(),
      second = await create();

    const inserted = await edit(first.reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep history" },
    });

    await edit(first.reviewId, { type: "remove", targetId: inserted.targetId });
    await store.close();
    store = new ReviewStore(database, providers);
    expect(store.read(first.reviewId).document).toEqual([]);
    expect(
      store.read(first.reviewId, inserted.version).document[0],
    ).toMatchObject({ id: inserted.targetId, markdown: "Keep history" });
    await store.execute(
      request({
        type: "restore",
        reviewId: first.reviewId,
        version: inserted.version,
      }),
    );

    const next = await edit(first.reviewId, {
      type: "insert",
      content: { type: "divider" },
    });

    expect(next.targetId).not.toBe(inserted.targetId);
    const beforeRepin = store.read(first.reviewId);
    await store.execute(
      request({
        type: "repin",
        reviewId: first.reviewId,
        pins: { ...pins, head: "new-head" },
      }),
    );
    expect(store.read(first.reviewId)).toMatchObject({
      document: beforeRepin.document,
      pins: { head: "new-head" },
    });
    expect(store.read(second.reviewId)).toMatchObject({
      document: [],
      version: 0,
      pins,
    });
    expect(store.list()).toHaveLength(2);
  });

  it("retains stale references on repin, reports them, and allows incremental repairs", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });
    await edit(reviewId, {
      type: "insert",
      content: { type: "software_map", mapVersionId: "map" },
    });
    const original = store.read(reviewId);
    vi.mocked(providers.validateSource).mockRejectedValue(
      new ReviewInputError("File is unavailable at the pinned commit.", 404),
    );
    vi.mocked(providers.validateResource).mockRejectedValue(
      new ReviewInputError("Map does not match this review's source pins."),
    );

    const command = request({
      type: "repin",
      reviewId,
      pins: { ...pins, head: "new-head" },
    });

    const result = await store.execute(command);

    expect(result.warnings).toEqual([
      "block-2 (software_map): Map does not match this review's source pins.",
      "head/src/store.ts#L1-L5: File is unavailable at the pinned commit.",
    ]);
    expect(await store.execute(command)).toEqual(result);
    expect(store.read(reviewId).document).toEqual(original.document);
    expect(store.read(reviewId, original.version)).toEqual(original);
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Working on the update" },
    });
    vi.mocked(providers.validateSource).mockResolvedValue();
    await edit(reviewId, {
      type: "update",
      targetId: original.document[0]!.id!,
      changes: { source: selectSource({ ...source, file: "renamed.ts" }) },
    });
    expect(store.read(reviewId).document[0]).toMatchObject({
      id: original.document[0]!.id,
      source: { file: "renamed.ts" },
    });
  });

  it("asks agents to verify retained ranges even when their line numbers remain valid", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });

    const result = await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    expect(result.warnings).toEqual([
      "head/src/store.ts#L1-L5: source pins changed; verify that this range still supports the document.",
    ]);

    const samePins = await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    expect(samePins.warnings).toBeUndefined();
  });

  it("does not save a repin when pin resolution or source infrastructure fails", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });
    const original = store.read(reviewId);
    vi.mocked(providers.validatePins).mockRejectedValueOnce(
      new ReviewInputError("Missing commit"),
    );
    await expect(
      store.execute(
        request({
          type: "repin",
          reviewId,
          pins: { ...pins, head: "missing" },
        }),
      ),
    ).rejects.toThrow("Missing commit");
    vi.mocked(providers.validateSource).mockRejectedValueOnce(
      new Error("Repository read failed"),
    );
    await expect(
      store.execute(
        request({
          type: "repin",
          reviewId,
          pins: { ...pins, head: "new-head" },
        }),
      ),
    ).rejects.toThrow("Repository read failed");
    expect(store.read(reviewId)).toEqual(original);
  });

  it("patches and reorders individual steps, and replacement gives descendants new IDs", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: diagram,
    });

    const value = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "sequence") throw new Error("Expected sequence");

      return block;
    };

    const step = value().steps[0]!.id;

    const second = await edit(reviewId, {
      type: "insert",
      parentId: targetId,
      afterId: step,
      content: {
        type: "step",
        from: "db",
        to: "app",
        label: "Reply",
        explanation: "Saved",
      },
    });

    await edit(reviewId, {
      type: "update",
      targetId: step,
      changes: { label: "Commit" },
    });
    expect(value().steps[0]).toMatchObject({
      id: step,
      label: "Commit",
      source: selectSource(source),
    });
    expect(providers.validateSource).toHaveBeenCalledTimes(1);
    await edit(reviewId, {
      type: "move",
      targetId: step,
      parentId: targetId,
      afterId: second.targetId,
    });
    expect(value().steps.map((s) => s.id)).toEqual([second.targetId, step]);
    await edit(reviewId, { type: "replace", targetId, content: diagram });
    expect(value().id).toBe(targetId);
    expect(value().steps[0]!.id).not.toBe(step);
    await expect(
      edit(reviewId, { type: "remove", targetId: step }),
    ).rejects.toThrow(/does not exist/);
  });

  it("names what an insert or replace wrote: the target's type and its first-level children", async () => {
    const { reviewId } = await create();

    const section = await edit(reviewId, {
      type: "insert",
      content: {
        type: "section",
        title: "Design",
        children: [
          { type: "markdown", markdown: "First" },
          {
            type: "callout",
            tone: "info",
            children: [{ type: "markdown", markdown: "Nested" }],
          },
          { type: "markdown", markdown: "Last" },
        ],
      },
    });

    const saved = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "section") throw new Error("Expected section");

      return block;
    };

    const listed = () =>
      saved().children.map(({ id, type }) => ({ id: id!, type }));

    // Grandchildren inside the callout are one read away, not listed here.
    expect(section).toMatchObject({
      targetId: saved().id,
      type: "section",
      children: listed(),
    });
    expect(section.children?.map((child) => child.type)).toEqual([
      "markdown",
      "callout",
      "markdown",
    ]);

    const leaf = await edit(reviewId, {
      type: "insert",
      parentId: section.targetId,
      content: { type: "markdown", markdown: "Leaf" },
    });

    expect(leaf.type).toBe("markdown");
    expect(leaf).not.toHaveProperty("children");

    const replaced = await edit(reviewId, {
      type: "replace",
      targetId: section.targetId,
      content: {
        type: "section",
        title: "Design",
        children: [
          { type: "markdown", markdown: "Fresh" },
          { type: "markdown", markdown: "Fresher" },
        ],
      },
    });

    expect(replaced).toMatchObject({
      targetId: section.targetId,
      type: "section",
      children: listed(),
    });
    expect(
      replaced.children?.some((child) =>
        section.children?.some((old) => old.id === child.id),
      ),
    ).toBe(false);

    const updated = await edit(reviewId, {
      type: "update",
      targetId: replaced.children![0]!.id,
      changes: { markdown: "Still a leaf" },
    });

    expect(updated.type).toBe("markdown");
    expect(updated).not.toHaveProperty("children");
  });

  it("lists a diagram's units as its children: steps, or nodes then edges", async () => {
    const { reviewId } = await create();

    const flow = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [
          { key: "a", label: "A", attachments: [] },
          { key: "b", label: "B", attachments: [] },
        ],
        edges: [{ from: "a", to: "b" }],
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    expect(flow).toMatchObject({
      type: "flow_diagram",
      children: [
        { id: block.nodes[0]!.id, type: "flow_node" },
        { id: block.nodes[1]!.id, type: "flow_node" },
        { id: block.edges[0]!.id, type: "flow_edge" },
      ],
    });

    const sequence = await edit(reviewId, { type: "insert", content: diagram });

    const steps = store.read(reviewId).document[1]!;

    if (steps.type !== "sequence") throw new Error("Expected sequence");
    expect(sequence).toMatchObject({
      type: "sequence",
      children: steps.steps.map((step) => ({ id: step.id, type: "step" })),
    });
  });

  it("lists a whole diagram's units in drawing order: each edge once both ends are drawn", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [
          { key: "a", label: "A", attachments: [] },
          { key: "b", label: "B", attachments: [] },
          { key: "c", label: "C", attachments: [] },
        ],
        edges: [
          { from: "a", to: "c" },
          { from: "a", to: "b" },
          { from: "c", to: "b" },
        ],
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    const [a, b, c] = block.nodes.map((node) => node.id);
    const [ac, ab, cb] = block.edges.map((edge) => edge.id);
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "insert",
      targetId,
      units: [a, b, ab, c, ac, cb],
    });

    const sequence = await edit(reviewId, {
      type: "replace",
      targetId,
      content: {
        type: "sequence",
        title: "Renewal",
        actors: { agent: "Agent", server: "Server" },
        steps: [
          {
            from: "agent",
            to: "server",
            label: "renew",
            style: "call",
            explanation: "Fresh expiry.",
          },
          {
            from: "server",
            to: "agent",
            label: "ok",
            style: "return",
            explanation: "Renewed.",
          },
        ],
      },
    });

    const replaced = store.read(reviewId).document[0]!;

    if (replaced.type !== "sequence") throw new Error("Expected sequence");
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "replace",
      targetId: sequence.targetId,
      units: replaced.steps.map((step) => step.id),
    });
  });

  it("draws a flow diagram one node and edge at a time, and a removed node takes its edges", async () => {
    const { reviewId } = await create();

    const { targetId: diagramId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [{ key: "session", label: "Session svc", attachments: [] }],
        edges: [],
      },
    });

    const value = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "flow_diagram") throw new Error("Expected flow");

      return block;
    };

    const session = value().nodes[0]!.id!;
    expect(session).toMatch(/^node-/);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: diagramId,
      blockId: diagramId,
      kind: "flow_diagram",
      units: [session],
    });

    const broker = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "broker",
        label: "Lease broker",
        attachments: [],
      },
    });

    const supervisor = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      afterId: session,
      content: {
        type: "flow_node",
        key: "sup",
        label: "Runtime sup",
        attachments: [],
      },
    });

    expect(value().nodes.map((node) => node.key)).toEqual([
      "session",
      "sup",
      "broker",
    ]);

    const acquires = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_edge",
        from: "session",
        to: "broker",
        label: "acquires",
      },
    });

    expect(acquires.targetId).toMatch(/^edge-/);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: acquires.targetId,
      blockId: diagramId,
      kind: "flow_edge",
      unit: "flow_edge",
    });

    await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: { type: "flow_edge", from: "broker", to: "sup" },
    });

    await edit(reviewId, {
      type: "update",
      targetId: broker.targetId,
      changes: { label: "Broker", kind: "decision" },
    });
    expect(value().nodes[2]).toMatchObject({
      id: broker.targetId,
      type: "flow_node",
      key: "broker",
      label: "Broker",
      kind: "decision",
    });
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "update",
      kind: "flow_node",
      fields: ["label", "kind"],
    });

    await edit(reviewId, {
      type: "update",
      targetId: acquires.targetId,
      changes: { label: "acquires a lease" },
    });
    expect(value().edges[0]).toMatchObject({ label: "acquires a lease" });

    // The outline and a targeted read see the units.
    expect(
      inspectSnapshot(store.read(reviewId), broker.targetId),
    ).toMatchObject({ type: "flow_node", key: "broker" });
    const outline = inspectSnapshot(store.read(reviewId));
    expect(
      Array.isArray(outline) ? outline.map((entry) => entry.type) : outline,
    ).toEqual([
      "flow_diagram",
      "flow_node",
      "flow_node",
      "flow_node",
      "flow_edge",
      "flow_edge",
    ]);

    await edit(reviewId, {
      type: "move",
      targetId: broker.targetId,
      parentId: diagramId,
      afterId: session,
    });
    expect(value().nodes.map((node) => node.key)).toEqual([
      "session",
      "broker",
      "sup",
    ]);

    await expect(
      edit(reviewId, {
        type: "replace",
        targetId: broker.targetId,
        content: { type: "divider" },
      }),
    ).rejects.toThrow(/Patch the flow_node/);
    await expect(
      edit(reviewId, {
        type: "insert",
        content: {
          type: "flow_node",
          key: "loose",
          label: "Loose",
          attachments: [],
        },
      }),
    ).rejects.toThrow(/belongs inside a flow_diagram/);
    await expect(
      edit(reviewId, {
        type: "insert",
        parentId: diagramId,
        content: { type: "flow_edge", from: "session", to: "missing" },
      }),
    ).rejects.toThrow(/Unknown flow endpoint/);

    await edit(reviewId, { type: "remove", targetId: broker.targetId });
    expect(value().nodes.map((node) => node.key)).toEqual(["session", "sup"]);
    expect(value().edges).toEqual([]);
    expect(supervisor.targetId).toMatch(/^node-/);

    // A removed unit is still attributed to its diagram; a rename is not an edit.
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "remove",
      targetId: broker.targetId,
      blockId: diagramId,
      kind: "flow_node",
      unit: "flow_node",
    });
    await store.execute(request({ type: "rename", reviewId, title: "Leases" }));
    expect(store.read(reviewId).lastEdit).toBeUndefined();

    // A node can arrive with the edge that attaches it, in one version.
    const sweeper = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "sweeper",
        label: "Sweeper",
        attachments: [],
        link: { from: "sup", label: "expires", style: "dashed" },
      },
    });

    expect(value().nodes.at(-1)).toMatchObject({
      id: sweeper.targetId,
      key: "sweeper",
    });
    expect(value().nodes.at(-1)).not.toHaveProperty("link");
    expect(value().edges).toMatchObject([
      { from: "sup", to: "sweeper", label: "expires", style: "dashed" },
    ]);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: sweeper.targetId,
      blockId: diagramId,
      kind: "flow_node",
      unit: "flow_node",
      linkId: value().edges[0]!.id,
    });
    await expect(
      edit(reviewId, {
        type: "insert",
        parentId: diagramId,
        content: {
          type: "flow_node",
          key: "both",
          label: "Both",
          attachments: [],
          link: { from: "sup", to: "sweeper" },
        },
      }),
    ).rejects.toThrow(/exactly one of from or to/);
    await expect(
      edit(reviewId, {
        type: "update",
        targetId: sweeper.targetId,
        changes: { link: { from: "session" } },
      }),
    ).rejects.toThrow(/only comes with a new node/);
  });

  it("accepts flow nodes with no code attachments and reads them back with an empty list", async () => {
    const { reviewId } = await create();

    const evidence = [{ label: "Entry", sources: [selectSource(source)] }];

    const { targetId: diagramId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "CLI",
        nodes: [
          { key: "run", label: "Run", attachments: evidence },
          { key: "ok", label: "exit 0", kind: "terminal" },
        ],
        edges: [{ from: "run", to: "ok" }],
      },
    });

    await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "fail",
        label: "exit 1",
        kind: "terminal",
        link: { from: "run" },
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    expect(
      block.nodes.map(({ key, attachments }) => ({ key, attachments })),
    ).toEqual([
      { key: "run", attachments: evidence },
      { key: "ok", attachments: [] },
      { key: "fail", attachments: [] },
    ]);

    // The published tool schema does not tell agents attachments are required.
    const nodeSchemas = (
      schema: z.core.JSONSchema._JSONSchema,
    ): z.core.JSONSchema.JSONSchema[] =>
      schema === true || schema === false
        ? []
        : [
            ...(schema.properties?.key && schema.properties.attachments
              ? [schema]
              : []),
            ...[
              ...Object.values(schema.properties ?? {}),
              ...(schema.anyOf ?? []),
              ...(schema.oneOf ?? []),
              ...[schema.items ?? []].flat(),
            ].flatMap(nodeSchemas),
          ];

    const published = nodeSchemas(
      authoringTools().find((tool) => tool.name === "review_edit")!.inputSchema,
    );

    expect(published.length).toBeGreaterThan(0);

    for (const schema of published)
      expect(schema.required).not.toContain("attachments");
  });

  it("moves blocks in both directions and between containers without duplicating them", async () => {
    const { reviewId } = await create();

    const insert = <Content>(content: Content) =>
      edit(reviewId, { type: "insert", content });

    const a = (await insert({ type: "divider" })).targetId,
      b = (await insert({ type: "divider" })).targetId;

    const c = (
      await insert({ type: "section", title: "Container", children: [] })
    ).targetId;

    await edit(reviewId, { type: "move", targetId: c, afterId: a });
    expect(store.read(reviewId).document.map((b) => b.id)).toEqual([a, c, b]);
    await edit(reviewId, { type: "move", targetId: a, afterId: b });
    expect(store.read(reviewId).document.map((b) => b.id)).toEqual([c, b, a]);
    await edit(reviewId, { type: "move", targetId: a, parentId: c });
    expect(store.read(reviewId).document).toMatchObject([
      { id: c, children: [{ id: a }] },
      { id: b },
    ]);
    await expect(
      edit(reviewId, { type: "move", targetId: c, parentId: a }),
    ).rejects.toThrow(Error);
  });

  it("does not save any part of an invalid edit or failed external check", async () => {
    const { reviewId } = await create();
    const before = store.read(reviewId);

    const invalid = [
      { type: "insert", afterId: "missing", content: { type: "divider" } },
      { type: "insert", content: { ...diagram, actors: {} } },
      {
        type: "insert",
        content: { type: "markdown", id: "client-id", markdown: "No" },
      },
      {
        type: "insert",
        content: {
          type: "code_peek",
          source: selectSource({ ...source, fromLine: 10 }),
        },
      },
    ];

    for (const op of invalid)
      await expect(async () => edit(reviewId, op)).rejects.toThrow(Error);
    providers.validateSource = async () => {
      throw new ReviewInputError("Range does not exist.");
    };

    await expect(
      edit(reviewId, {
        type: "insert",
        content: { type: "code_peek", source: selectSource(source) },
      }),
    ).rejects.toThrow(/Range/);
    expect(store.read(reviewId)).toEqual(before);
    expect(store.history(reviewId).map((item) => item.version)).toEqual([0]);
    expect(
      (await edit(reviewId, { type: "insert", content: { type: "divider" } }))
        .targetId,
    ).toBe("block-1");
  });

  it("rejects whitespace-only ranges wherever they render as a peek", async () => {
    const { reviewId } = await create();
    const before = store.read(reviewId);
    const calls: boolean[] = [];

    providers.validateSource = async (_pins, _source, options) => {
      calls.push(options.peek);

      if (options.peek)
        throw new ReviewInputError(
          "Source range src/store.ts:1-5 contains only whitespace.",
        );
    };

    const peekInserts = [
      {
        type: "sequence",
        title: "Save",
        actors: { a: "App", s: "Server" },
        steps: [
          { from: "a", to: "s", label: "save", source: selectSource(source) },
        ],
      },
      {
        type: "call_stack_diff",
        title: "Save path",
        base: [],
        head: [{ key: "save", label: "save", source: selectSource(source) }],
      },
      {
        type: "database_lens",
        title: "Saves",
        actors: { s: "Server" },
        stores: {
          db: {
            label: "DB",
            storage: "relational",
            collections: {
              saves: {
                label: "Saves",
                fields: { id: { label: "id", dataType: "text" } },
              },
            },
          },
        },
        useCases: [
          {
            label: "Save",
            operations: [
              {
                kind: "write",
                store: "db",
                collection: "saves",
                actor: "s",
                label: "insert",
                source: selectSource(source),
              },
            ],
          },
        ],
      },
    ];

    for (const content of peekInserts)
      await expect(edit(reviewId, { type: "insert", content })).rejects.toThrow(
        /contains only whitespace/,
      );

    expect(store.read(reviewId)).toEqual(before);

    const link = await edit(reviewId, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: `[save](review-source:${source.side}/${source.file}#L${source.fromLine}-L${source.toLine})`,
      },
    });

    expect(link.targetId).toBe("block-1");
    expect(calls).toEqual([true, true, true, false]);
  });

  it("validates a reference at its own pins, and leaves it alone when the document repins", async () => {
    const { reviewId } = await create();
    const own = { repositoryId: "repo-b", head: "b".repeat(40) };
    const validated: { pins: unknown; file: string }[] = [];
    const pinned: unknown[] = [];

    providers.validateSource = async (pins, source) => {
      validated.push({ pins, file: source.file });
    };

    providers.validatePins = async (pins) => {
      pinned.push(pins);
    };

    await edit(reviewId, {
      type: "insert",
      content: {
        type: "code_peek",
        source: { ...selectSource(source), file: "src/other.ts", pins: own },
      },
    });
    await edit(reviewId, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: "[keep](review-source:head/src/store.ts#L1-L5)",
      },
    });

    // The peek was read at its own pins (base defaults to head); the link at the document's.
    expect(validated).toEqual([
      { pins: { ...own, base: own.head }, file: "src/other.ts" },
      { pins, file: source.file },
    ]);
    expect(pinned).toEqual([{ ...own, base: own.head }]);

    validated.length = 0;
    await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    // Repinning the document re-checks inherited references only.
    expect(validated).toEqual([
      { pins: { ...pins, head: "new-head" }, file: source.file },
    ]);

    // Rejected at the command boundary, before any validation runs.
    await expect(async () =>
      edit(reviewId, {
        type: "insert",
        content: {
          type: "code_peek",
          source: {
            file: "src/other.ts",
            start: { side: "base", line: 1 },
            end: { side: "base", line: 2 },
            pins: own,
          },
        },
      }),
    ).rejects.toThrow(/base-side endpoint needs base pins/);
  });

  it("keeps one scratchpad: made on demand, drawn on at explicit pins only, outside the review lifecycle", async () => {
    await store.ensureScratchpad();
    await store.ensureScratchpad();
    const pad = store.read(SCRATCHPAD_ID);
    expect(pad).toMatchObject({ kind: "scratchpad", title: "Scratchpad" });
    expect(pad.pins).toBeUndefined();
    expect(pad.target).toBeUndefined();
    expect(store.list()).toMatchObject([
      { reviewId: SCRATCHPAD_ID, kind: "scratchpad" },
    ]);
    await expect(
      store.execute(
        request({ type: "create", title: "Another", kind: "scratchpad" }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    // Nothing to inherit: a reference must name its own pins.
    await expect(
      edit(SCRATCHPAD_ID, {
        type: "insert",
        content: { type: "code_peek", source: selectSource(source) },
      }),
    ).rejects.toThrow(/document has no pins/);
    const own = { repositoryId: "repo-b", head: "b".repeat(40) };
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: {
        type: "code_peek",
        source: { ...selectSource(source), pins: own },
      },
    });
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: "[store](review-source:head/src/store.ts#L1)",
        pins: own,
      },
    });

    const refused = [
      { type: "delete", reviewId: SCRATCHPAD_ID },
      { type: "attention", reviewId: SCRATCHPAD_ID, action: "view" },
      { type: "rename", reviewId: SCRATCHPAD_ID, title: "Notes" },
      { type: "repin", reviewId: SCRATCHPAD_ID, pins },
      {
        type: "set_target",
        reviewId: SCRATCHPAD_ID,
        target: { kind: "commits", repositoryId: "repo", head: "h" },
      },
    ];

    for (const operation of refused)
      await expect(store.execute(request(operation))).rejects.toMatchObject({
        status: 409,
      });
    expect(store.read(SCRATCHPAD_ID).version).toBe(2);
    await store.execute(
      request({ type: "restore", reviewId: SCRATCHPAD_ID, version: 1 }),
    );
    expect(store.read(SCRATCHPAD_ID).document).toHaveLength(1);
  });

  it("logs the scratchpad newest first while a review keeps appending", async () => {
    await store.ensureScratchpad();
    const note = (markdown: string) => ({ type: "markdown", markdown });

    const order = (reviewId: string) =>
      store
        .read(reviewId)
        .document.map((block) => "markdown" in block && block.markdown);

    const first = await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: note("first"),
    });

    await edit(SCRATCHPAD_ID, { type: "insert", content: note("second") });
    expect(order(SCRATCHPAD_ID)).toEqual(["second", "first"]);

    // An explicit anchor still wins: the block lands after it, not on top.
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: note("after first"),
      afterId: first.targetId,
    });
    expect(order(SCRATCHPAD_ID)).toEqual(["second", "first", "after first"]);

    const { reviewId } = await create();
    await edit(reviewId, { type: "insert", content: note("first") });
    await edit(reviewId, { type: "insert", content: note("second") });
    expect(order(reviewId)).toEqual(["first", "second"]);
  });

  it("serializes edits through async validation and preserves different-field patches", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: { type: "code", text: "old", caption: "old" },
    });

    let release!: () => void, started!: () => void;

    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });

    providers.validateSource = () => {
      started();

      return new Promise((resolve) => {
        release = resolve;
      });
    };

    const pending = edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });

    await entered;

    const a = edit(reviewId, {
      type: "update",
      targetId,
      changes: { text: "first" },
    });

    const b = edit(reviewId, {
      type: "update",
      targetId,
      changes: { caption: "second" },
    });

    release();
    await Promise.all([pending, a, b]);
    expect(store.inspect(reviewId, targetId)).toMatchObject({
      text: "first",
      caption: "second",
    });
    await edit(reviewId, {
      type: "update",
      targetId,
      changes: { text: "last" },
    });
    expect(store.inspect(reviewId, targetId)).toMatchObject({
      text: "last",
      caption: "second",
    });
  });

  it("replays a lost response after restart, but rejects reuse with a different edit", async () => {
    const { reviewId } = await create();

    const command = request({
      type: "edit",
      reviewId,
      edit: { type: "insert", content: { type: "divider" } },
    });

    const result = await store.execute(command);
    await store.close();
    store = new ReviewStore(database, providers);
    expect(await store.execute(command)).toEqual(result);
    expect(store.read(reviewId).document).toHaveLength(1);
    await expect(
      store.execute({
        ...command,
        operation: { type: "rename", reviewId, title: "Different" },
      }),
    ).rejects.toThrow(/already used/);
  });
});

describe("create for a pull request", () => {
  const url = "https://github.com/devdotfast/review/pull/452";

  const createFor = (
    pullRequestUrl?: string,
    fields: {
      pins?: typeof pins;
      reuseExisting?: boolean;
      title?: string;
    } = {},
  ) =>
    store.execute(
      request({
        type: "create",
        title: fields.title ?? "PR review",
        pins: fields.pins ?? pins,
        pullRequestUrl,
        ...(fields.reuseExisting !== undefined && {
          reuseExisting: fields.reuseExisting,
        }),
      }),
    );

  it("returns the PR's existing review, unchanged, instead of making another", async () => {
    const first = await createFor(url);
    expect(first).toMatchObject({ created: true });
    await edit(first.reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep this" },
    });

    const again = await createFor(
      url.replace("devdotfast/review", "DevDotFast/Review"),
      {
        title: "Ignored title",
      },
    );

    expect(again).toMatchObject({
      created: false,
      reviewId: first.reviewId,
      version: 1,
      target: { kind: "commits", ...pins },
      headMoved: false,
    });
    expect(again.note).toEqual(expect.any(String));
    expect(again.ownedBy).toBeUndefined();
    expect(again.otherReviewIds).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.read(first.reviewId)).toMatchObject({
      title: "PR review",
      version: 1,
      origin: { pullRequestUrl: url },
    });
  });

  it("reports a moved head without moving the target", async () => {
    const { reviewId } = await createFor(url);

    const moved = await createFor(url, { pins: { ...pins, head: "new-head" } });

    expect(moved).toMatchObject({ created: false, reviewId, headMoved: true });
    expect(moved.note).toMatch(/review_set_target/);
    expect(store.read(reviewId).pins).toEqual(pins);
  });

  it("compares a requested target by the head it resolves to", async () => {
    providers.resolveTarget = vi.fn<
      NonNullable<ReviewProviders["resolveTarget"]>
    >(async (target) => ({
      target,
      pins: {
        ...pins,
        head:
          target.kind === "commits" && target.head === "main"
            ? pins.head
            : "other",
      },
    }));
    const target = { kind: "commits", repositoryId: "repo", head: "main" };

    const { reviewId } = await store.execute(
      request({ type: "create", title: "PR", target, pullRequestUrl: url }),
    );

    expect(
      await store.execute(
        request({ type: "create", title: "PR", target, pullRequestUrl: url }),
      ),
    ).toMatchObject({ created: false, reviewId, headMoved: false });
    expect(
      await store.execute(
        request({
          type: "create",
          title: "PR",
          target: { ...target, head: "feature" },
          pullRequestUrl: url,
        }),
      ),
    ).toMatchObject({ created: false, reviewId, headMoved: true });
  });

  it("creates another review on request and then returns the newest, naming the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const at = (minute: number) =>
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 22, 12, minute)));

    at(0);
    const oldest = await createFor(url);
    at(1);
    const newer = await createFor(url, { reuseExisting: false });

    expect(newer).toMatchObject({ created: true });
    expect(newer.reviewId).not.toBe(oldest.reviewId);

    const found = await createFor(url);

    expect(found).toMatchObject({
      created: false,
      reviewId: newer.reviewId,
      otherReviewIds: [oldest.reviewId],
    });

    // Editing the older review makes it the most recently updated.
    at(2);
    await edit(oldest.reviewId, {
      type: "insert",
      content: { type: "divider" },
    });
    expect(await createFor(url)).toMatchObject({
      reviewId: oldest.reviewId,
      otherReviewIds: [newer.reviewId],
    });
    expect(store.list()).toHaveLength(2);
  });

  it("says when another session is authoring the review it returns", async () => {
    const { reviewId } = await createFor(url);
    const leaseId = randomUUID();
    store.activity.update(reviewId, { action: "begin", leaseId });

    const found = await createFor(url);

    expect(found).toMatchObject({
      created: false,
      reviewId,
      ownedBy: "another session",
    });
    expect(
      await store.execute({
        ...request({ type: "create", title: "PR", pins, pullRequestUrl: url }),
        leaseId,
      }),
    ).not.toHaveProperty("ownedBy");
  });

  it("replays a found review for a repeated command and rejects a changed one", async () => {
    const { reviewId } = await createFor(url);

    const repeat = request({
      type: "create",
      title: "PR",
      pins,
      pullRequestUrl: url,
    });

    const found = await store.execute(repeat);
    await edit(reviewId, { type: "insert", content: { type: "divider" } });
    await store.close();
    store = new ReviewStore(database, providers);

    expect(await store.execute(repeat)).toEqual(found);
    await expect(
      store.execute({
        ...repeat,
        operation: { ...repeat.operation, reuseExisting: false },
      }),
    ).rejects.toThrow(/already used/);
    expect(store.list()).toHaveLength(1);

    await store.execute(request({ type: "delete", reviewId }));
    await expect(store.execute(repeat)).rejects.toThrow(/was deleted/);
  });

  it("leaves creates without a PR, other PRs and the scratchpad alone", async () => {
    const first = await createFor(undefined);
    const second = await createFor(undefined);
    const otherPr = await createFor(url);
    const samePrElsewhere = await createFor(url.replace("452", "4520"));

    for (const result of [first, second, otherPr, samePrElsewhere])
      expect(result).toMatchObject({ created: true });
    await store.ensureScratchpad();
    expect(store.read(SCRATCHPAD_ID).kind).toBe("scratchpad");
    expect(store.list()).toHaveLength(5);
  });

  it("takes the source and title from the PR when only its URL is given", async () => {
    const resolvePullRequest = vi.fn<
      NonNullable<ReviewProviders["resolvePullRequest"]>
    >(async () => ({
      target: { kind: "commits", ...pins },
      pins,
      title: "From GitHub",
    }));

    providers.resolvePullRequest = resolvePullRequest;

    const untitled = await store.execute(
      request({ type: "create", pullRequestUrl: url }),
    );

    const titled = await store.execute(
      request({
        type: "create",
        title: "Mine",
        pullRequestUrl: url,
        reuseExisting: false,
        repositoryId: "repo",
      }),
    );

    expect(store.read(untitled.reviewId)).toMatchObject({
      title: "From GitHub",
      pins,
      origin: { pullRequestUrl: url },
    });
    expect(store.read(titled.reviewId).title).toBe("Mine");
    expect(resolvePullRequest.mock.calls).toEqual([
      [url, { id: undefined, preferred: undefined }],
      [url, { id: "repo", preferred: undefined }],
    ]);

    // A repeat prefers the checkout of the review it will find.
    await store.execute(request({ type: "create", pullRequestUrl: url }));
    expect(resolvePullRequest).toHaveBeenLastCalledWith(url, {
      id: undefined,
      preferred: "repo",
    });
  });

  it("needs a source, and a title unless a PR supplies it", async () => {
    await expect(
      store.execute(request({ type: "create", title: "Nothing" })),
    ).rejects.toThrow(/target, legacy pins, or a pullRequestUrl/);
    await expect(
      store.execute(request({ type: "create", pins })),
    ).rejects.toThrow(/Supply a title/);
    await expect(
      store.execute(
        request({
          type: "create",
          title: "Both",
          pins,
          pullRequestUrl: url,
          repositoryId: "repo",
        }),
      ),
    ).rejects.toThrow(/repositoryId applies only/);
    expect(store.list()).toEqual([]);
  });
});

it("serves the experiment through the real desktop HTTP server and existing authentication", async () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  const relay = new GlobalReviewDesktopVerbRelay();

  // The scratchpad preference is off by default; this host has it on.
  writeFileSync(
    path.join(directory, "preferences.json"),
    JSON.stringify({ scratchpadEnabled: true }),
  );

  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "test-token",
    discoveryPath: path.join(directory, "desktop.json"),
    reviewStore: store,
    reviewData: new LocalReviewData(store),
    relay,
  });

  try {
    await server.listen();
    const url = server.url + "/reviews-api";
    expect((await fetch(url)).status).toBe(401);

    const headers = {
      "content-type": "application/json",
      "x-review-token": "test-token",
    };

    const post = <Operation>(operation: Operation) =>
      fetch(url + "/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(request(operation)),
      });

    const response = await post({ type: "create", title: "HTTP review", pins });
    expect(response.status).toBe(200);
    const created = await response.json();
    const { reviewId } = created;
    // The result names what was created: the review's own catalog entry.
    const entries = await (await fetch(url, { headers })).json();
    expect(created.review).toEqual(
      entries.find(
        (review: { reviewId: string }) => review.reviewId === reviewId,
      ),
    );
    expect(created.review).toMatchObject({
      title: "HTTP review",
      target: { kind: "commits", head: pins.head },
    });
    expect(
      (await fetch(`${url}/${reviewId}/open`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (await fetch(`${url}/missing/open`, { method: "POST", headers })).status,
    ).toBe(404);
    // A server without a desktop must not report that it opened a window.
    expect(
      (await fetch(`${url}/${reviewId}/open`, { method: "POST", headers }))
        .status,
    ).toBe(409);

    const client = new ReviewApiClient({
      serverUrl: server.url,
      token: "test-token",
    });

    const tools = await client.read<AuthoringTool[]>("/authoring");
    let softwareMapEnabled = false;
    relay.attach({
      signal: new AbortController().signal,
      write(frame) {
        const { id, request } = JSON.parse(frame.slice(6));
        relay.acceptResult({
          id,
          response:
            request.name === "openApiReview" &&
            request.args.reviewId === reviewId
              ? { ok: true, result: { softwareMapEnabled } }
              : { ok: false, error: "Unexpected desktop request" },
        });
      },
      close() {},
    });

    for (const enabled of [false, true, false]) {
      softwareMapEnabled = enabled;
      expect(
        await callAuthoringTool(
          client,
          tools.find((t) => t.name === "review_open")!,
          { reviewId },
        ),
      ).toMatchObject({
        ok: true,
        softwareMapEnabled: enabled,
      });
    }

    expect(
      await callAuthoringTool(
        client,
        tools.find((t) => t.name === "review_environment")!,
        { reviewId },
      ),
    ).toEqual({
      issues: [
        { side: "head" as const, message: "Repository is not registered." },
        { side: "base", message: "Repository is not registered." },
      ],
    });

    relay.close();

    // Listing through the interactive host, with the preference on, also
    // makes the one scratchpad.
    // SAFETY: review_list returns the catalog summaries the store lists.
    const listed = (await callAuthoringTool(
      client,
      tools.find((t) => t.name === "review_list")!,
      {},
    )) as { reviewId: string; kind?: string }[];

    const reviewsOnly = (entries: { kind?: string }[]) =>
      entries.filter((entry) => entry.kind !== "scratchpad");

    expect(reviewsOnly(listed)).toMatchObject([{ reviewId }]);
    expect(listed).toContainEqual(
      expect.objectContaining({ reviewId: SCRATCHPAD_ID, kind: "scratchpad" }),
    );
    await expect(
      callAuthoringTool(client, tools.find((t) => t.name === "review_edit")!, {
        commandId: randomUUID(),
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: selectSource({
              side: "head" as const,
              file: "x",
              fromLine: 0,
              toLine: 1,
            }),
          },
        },
      }),
    ).rejects.toThrow(/start.line/);
    const abort = new AbortController();
    const catalog = client.watch(null, abort.signal);
    expect(reviewsOnly((await catalog.next()).value)).toMatchObject([
      { reviewId, dismissedAt: null },
    ]);
    await post({ type: "attention", reviewId, action: "dismiss" });
    expect(reviewsOnly((await catalog.next()).value)).toMatchObject([
      { reviewId, dismissedAt: expect.any(String) },
    ]);
    await catalog.return(undefined);
    const live = client.watch(reviewId, abort.signal);
    expect((await live.next()).value).toMatchObject({
      reviewId,
      version: 0,
      document: [],
    });
    expect(
      (
        await post({
          type: "edit",
          reviewId,
          edit: { type: "insert", content: diagram },
        })
      ).status,
    ).toBe(200);
    const read = await fetch(url + "/" + reviewId + "?full=true", { headers });
    expect((await live.next()).value).toMatchObject({
      version: 1,
      document: [{ type: "sequence" }],
    });
    await live.return(undefined);
    abort.abort();
    const reconnect = client.watch(reviewId, new AbortController().signal);
    expect((await reconnect.next()).value).toMatchObject({ version: 1 });
    await reconnect.return(undefined);
    expect(await read.json()).toMatchObject({
      title: "HTTP review",
      version: 1,
      document: [{ type: "sequence" }],
    });

    const missing = await post({
      type: "edit",
      reviewId,
      edit: { type: "remove", targetId: "missing" },
    });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: expect.stringContaining("does not exist"),
    });
    expect(
      (
        await fetch(url + "/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
        })
      ).status,
    ).toBe(413);
    const watching = client.watch(reviewId, new AbortController().signal);
    await watching.next();

    await Promise.all([
      expect(watching.next()).rejects.toThrow(Error),
      post({ type: "delete", reviewId }).then((response) => {
        expect(response.status).toBe(200);
      }),
    ]);
    expect(
      (await fetch(`${url}/${reviewId}?full=true`, { headers })).status,
    ).toBe(404);
  } finally {
    await server.close();
  }
});

it("reads, updates and restores a section saved with the retired status field, and rejects new status writes", async () => {
  const { reviewId } = await create();

  const inserted = await edit(reviewId, {
    type: "insert",
    content: { type: "section", title: "Design", children: [] },
  });

  await store.close();
  // A version saved while sections still carried a status.
  const db = new DatabaseSync(database);
  db.prepare(
    `UPDATE versions SET snapshot=json_set(snapshot,'$.document[0].status','in_progress') WHERE review_id=?`,
  ).run(reviewId);
  db.close();
  store = new ReviewStore(database, providers);

  expect(store.read(reviewId).document[0]).not.toHaveProperty("status");
  expect(documentText(store.read(reviewId))).not.toContain("Status");

  await edit(reviewId, {
    type: "update",
    targetId: inserted.targetId,
    changes: { title: "Design notes" },
  });
  expect(store.read(reviewId).document[0]).toEqual({
    id: inserted.targetId,
    type: "section",
    title: "Design notes",
    children: [],
  });

  await store.execute(
    request({ type: "restore", reviewId, version: inserted.version }),
  );
  expect(store.read(reviewId).document[0]).toEqual({
    id: inserted.targetId,
    type: "section",
    title: "Design",
    children: [],
  });

  const version = store.read(reviewId).version;

  await expect(
    edit(reviewId, {
      type: "update",
      targetId: inserted.targetId,
      changes: { status: "complete" },
    }),
  ).rejects.toThrow(/Unrecognized key/);
  await expect(async () =>
    edit(reviewId, {
      type: "insert",
      content: {
        type: "section",
        title: "Plan",
        status: "pending",
        children: [],
      },
    }),
  ).rejects.toThrow(/Unrecognized key/);
  expect(store.read(reviewId).version).toBe(version);
});

it("persists partial coverage outside document versions and resets it for a changed file", async () => {
  const { reviewId } = await create();
  const version = store.read(reviewId).version;
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "old",
        scope: { base: [], head: [[0, 10]] },
      },
    ],
    true,
  );
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "old",
        scope: { base: [], head: [[5, 15]] },
      },
    ],
    true,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([
    [0, 15],
  ]);
  expect(store.read(reviewId).version).toBe(version);
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([
    [0, 15],
  ]);
  store.updateViewedCoverage(
    reviewId,
    [{ path: "a.ts", fingerprint: "old", scope: { base: [], head: [[4, 8]] } }],
    false,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([
    [0, 4],
    [8, 15],
  ]);
  store.updateViewedCoverage(
    reviewId,
    [
      {
        path: "a.ts",
        fingerprint: "new",
        scope: { base: [], head: [[20, 22]] },
      },
    ],
    true,
  );
  expect(store.viewedCoverage(reviewId).get("a.ts")?.coverage.head).toEqual([
    [20, 22],
  ]);
});

it("keeps reference coverage apart by pins: one path, changed under one comparison and not another", async () => {
  const { reviewProgress } = await import("./review-progress.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  const text = "first\nsecond\nthird";
  const changed = { ...pins, base: "other-base", head: "other-head" };
  const same = { repositoryId: pins.repositoryId, head: "other-head" };
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* ({
    pins: at,
  }) {
    const files =
      at.base === at.head
        ? []
        : [
            {
              file: {
                lhs: { path: "a.ts", oid: at.base, mode: "100644" },
                rhs: { path: "a.ts", oid: at.head, mode: "100644" },
              },
              status: "modified" as const,
            },
          ];

    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: at.base },
      rhs: { type: "revision", rev: at.head },
      files,
    };

    for (const file of files)
      yield {
        type: "file",
        file: file.file,
        diff: {
          type: "text",
          lhs: { text: text },
          rhs: { text: text },
          structural_changes: { base: [], head: [[0, 3]] },
          stats: {
            textual: { added: 3, removed: 0 },
            visible: { added: 3, removed: 0 },
          },
        },
      };
    yield { type: "complete", succeeded: files.length, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (at, side, file) => ({
    file,
    side,
    commit: at[side],
    text,
  }));

  const cite = (at: typeof changed | typeof same) => ({
    file: "a.ts",
    start: { side: "head" as const, line: 1 },
    end: { side: "head" as const, line: 2 },
    pins: at,
  });

  await edit(reviewId, {
    type: "insert",
    content: {
      type: "flow_diagram",
      title: "Two pins",
      nodes: [
        {
          key: "changed",
          label: "Changed there",
          attachments: [{ label: "a", sources: [cite(changed)] }],
        },
        {
          key: "same",
          label: "Unchanged there",
          attachments: [{ label: "a", sources: [cite(same)] }],
        },
      ],
      edges: [{ from: "changed", to: "same" }],
    },
  });

  const progress = await reviewProgress(store, data, store.read(reviewId));

  // The document's own comparison stays in `files`; each reference's
  // comparison is its own group.
  expect(progress.files.map((file) => file.path)).toEqual(["a.ts"]);
  expect(Object.keys(progress.referenceFiles!).sort()).toEqual([
    "repo:other-base:other-head",
    "repo:other-head:other-head",
  ]);
  expect(
    progress.referenceFiles!["repo:other-base:other-head"]!["a.ts"],
  ).toMatchObject({
    changed: { base: [], head: [[0, 3]] },
  });
  expect(progress.referenceFiles!["repo:other-head:other-head"]).toEqual({});
});

it("preserves unchanged partial file coverage across pins and rejects stale writes after either file side changes", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewProgress } = await import("./review-progress.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let head = "first\nsecond\ncontext";
  let base = "first\nold\ncontext";
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "a.ts", oid: "base", mode: "100644" },
            rhs: { path: "a.ts", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "a.ts", oid: "base", mode: "100644" },
        rhs: { path: "a.ts", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: base },
        rhs: { text: head },
        structural_changes: { base: [[1, 2]], head: [[1, 2]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? head : base,
  }));
  const api = createReviewApi(store, data);
  const initial = await reviewProgress(store, data, store.read(reviewId));

  await data.coverage(reviewId, pins, "structural");
  expect(store.list()[0].diffStats).toEqual({
    fileCount: 1,
    additions: 1,
    deletions: 1,
  });
  expect(data.structuralChanges).toHaveBeenCalledTimes(1);
  expect(store.list("textual")[0].diffStats).toBeNull();

  const mark = (fingerprint: string, version: number) =>
    api.request(`/${reviewId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version,
        viewed: true,
        files: [
          {
            path: "a.ts",
            fingerprint,
            sources: [
              { side: "head" as const, file: "a.ts", fromLine: 2, toLine: 2 },
            ],
          },
        ],
      }),
    });

  expect((await mark(initial.files[0].fingerprint, 0)).status).toBe(200);
  await store.execute(
    request({ type: "repin", reviewId, pins: { ...pins, head: "new-pin" } }),
  );
  expect(
    (await reviewProgress(store, data, store.read(reviewId))).files[0].viewed
      .head,
  ).toEqual([[1, 2]]);
  head += "\nchanged outside the hunk";
  await store.execute(
    request({
      type: "repin",
      reviewId,
      pins: { ...pins, head: "changed-head" },
    }),
  );
  expect(
    (await reviewProgress(store, data, store.read(reviewId))).files[0].viewed
      .head,
  ).toEqual([]);
  expect((await mark(initial.files[0].fingerprint, 0)).status).toBe(409);
  const next = await reviewProgress(store, data, store.read(reviewId));
  expect(
    (await mark(next.files[0].fingerprint, store.read(reviewId).version))
      .status,
  ).toBe(200);
  base += "\nnew base context";
  await store.execute(
    request({
      type: "repin",
      reviewId,
      pins: { ...pins, base: "changed-base", head: "changed-head" },
    }),
  );
  expect(
    (await reviewProgress(store, data, store.read(reviewId))).files[0].viewed
      .head,
  ).toEqual([]);
});

it("textual coverage uses Git ranges without launching diffr", async () => {
  const { createReviewApi } = await import("./http.js");
  const { coverageProgress } = await import("../viewed-coverage.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (
    _pins: typeof pins,
    file?: string,
  ) =>
    file
      ? "@@ -1 +1 @@\n-const x=1;\n+const x = 1;\n"
      : [
          { path: "a.ts", status: "modified", additions: 1, deletions: 1 },
        ]) as typeof data.changes);
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? "const x = 1;" : "const x=1;",
  }));
  const structural = vi.spyOn(data, "structuralChanges");

  const response = await createReviewApi(store, data).request(
    `/${reviewId}/progress?mode=textual`,
  );

  expect(response.status).toBe(200);
  const progress = await response.json();
  expect(coverageProgress(progress.files).total).toEqual({
    additions: 1,
    deletions: 1,
  });
  await data.coverage(reviewId, pins, "textual");
  const api = createReviewApi(store, data);
  const textualCatalog = await (await api.request("/?mode=textual")).json();
  expect(textualCatalog[0].diffStats).toEqual({
    fileCount: 1,
    additions: 1,
    deletions: 1,
  });
  expect(structural).not.toHaveBeenCalled();
  structural.mockImplementation(async function* () {
    const file = {
      lhs: { path: "a.ts", oid: "base", mode: "100644" },
      rhs: { path: "a.ts", oid: "head", mode: "100644" },
    };

    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [{ file, status: "modified" }],
    };
    yield {
      type: "file",
      file,
      diff: {
        type: "text",
        lhs: { text: "const x=1;" },
        rhs: { text: "const x = 1;" },
        structural_changes: { base: [], head: [] },
        stats: {
          textual: { added: 1, removed: 1 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    throw new Error("Counts must not wait for summary events");
  });
  await data.coverage(reviewId, pins, "structural");

  const structuralCatalog = await (
    await api.request("/?mode=structural")
  ).json();

  expect(structuralCatalog[0].diffStats).toEqual({
    fileCount: 1,
    additions: 0,
    deletions: 0,
  });

  const structuralProgress = await (
    await api.request(`/${reviewId}/progress?mode=structural`)
  ).json();

  expect(coverageProgress(structuralProgress.files).total).toEqual({
    additions: 0,
    deletions: 0,
  });
  expect(structural).toHaveBeenCalledTimes(1);
  expect(store.list("textual")[0].diffStats).toEqual(
    textualCatalog[0].diffStats,
  );
});

it("resolves file lenses to whole changed files, preserves empty groups, and shares viewed coverage", async () => {
  const { reviewProgress } = await import("./review-progress.js");
  const { coverageProgress } = await import("../viewed-coverage.js");
  const { reviewId } = await create();

  for (const [title, patterns] of [
    ["Docs", ["docs/**", "docs/old.md"]],
    ["Guide", ["guide/**"]],
    ["Tests", ["**/*.test.ts"]],
  ] as const)
    await writeLens(reviewId, {
      type: "insert",
      title,
      targets: [{ kind: "files", patterns }],
    });
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "docs/old.md", oid: "base", mode: "100644" },
            rhs: { path: "guide/intro.md", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "docs/old.md", oid: "base", mode: "100644" },
        rhs: { path: "guide/intro.md", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: "base\ncontext\nmore context" },
        rhs: { text: "head\ncontext\nmore context" },
        structural_changes: { base: [[0, 1]], head: [[0, 1]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: `${side}\ncontext\nmore context`,
  }));
  const initial = await reviewProgress(store, data, store.read(reviewId));
  const [docs, guide, tests] = initial.lenses;
  expect(docs.fileCount).toBe(1);
  expect(docs.sources).toEqual([
    { side: "base", file: "docs/old.md", fromLine: 1, toLine: 3 },
    { side: "head" as const, file: "guide/intro.md", fromLine: 1, toLine: 3 },
  ]);
  expect(guide.sources).toEqual(docs.sources);
  expect(tests.fileCount).toBe(0);
  expect(tests.sources).toEqual([]);
  expect(tests.unavailable).toBeTruthy();
  store.updateViewedCoverage(
    reviewId,
    initial.files.map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
      scope: file.changed,
    })),
    true,
  );
  const viewed = await reviewProgress(store, data, store.read(reviewId));
  expect(coverageProgress(viewed.files, docs.sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files, guide.sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files).total).toEqual({
    additions: 1,
    deletions: 1,
  });
});

it("validates range lens evidence and scopes progress and Uncategorized to distinct changed lines", async () => {
  const { reviewProgress } = await import("./review-progress.js");

  const { coverageProgress, scopedCoverage } =
    await import("../viewed-coverage.js");

  const { reviewId } = await create();

  const selected = {
    side: "head" as const,
    file: "src/a.ts",
    fromLine: 2,
    toLine: 2,
  };

  const { targetId: lensId } = await writeLens(reviewId, {
    type: "insert",
    title: "One line",
    targets: [
      {
        kind: "ranges",
        sources: [selectSource(selected), selectSource(selected)],
      },
    ],
  });

  expect(providers.validateSource).toHaveBeenCalledWith(
    pins,
    selected,
    expect.anything(),
  );
  // A diagram's evidence stays in the document: it is not a Diff-view lens
  // and does not categorize the lines it cites.
  await edit(reviewId, {
    type: "insert",
    content: {
      ...diagram,
      steps: [
        {
          ...diagram.steps[0],
          source: selectSource({ ...selected, fromLine: 1, toLine: 1 }),
        },
      ],
    },
  });
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [
        {
          file: {
            lhs: { path: "src/a.ts", oid: "base", mode: "100644" },
            rhs: { path: "src/a.ts", oid: "head", mode: "100644" },
          },
          status: "modified",
        },
      ],
    };
    yield {
      type: "file",
      file: {
        lhs: { path: "src/a.ts", oid: "base", mode: "100644" },
        rhs: { path: "src/a.ts", oid: "head", mode: "100644" },
      },
      diff: {
        type: "text",
        lhs: { text: "base1\nbase2\nbase3" },
        rhs: { text: "head1\nhead2\nhead3" },
        structural_changes: { base: [[0, 3]], head: [[0, 3]] },
        stats: {
          textual: { added: 99, removed: 99 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    yield { type: "complete", succeeded: 1, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: `${side}1\n${side}2\n${side}3`,
  }));
  const result = await reviewProgress(store, data, store.read(reviewId));

  const lens = result.lenses[0],
    rest = result.lenses.find((lens) => lens.id === "automatic-uncategorized")!;

  expect(result.lenses.map((lens) => lens.title)).toEqual([
    "One line",
    "Uncategorized changes",
  ]);
  expect(lens.sources).toEqual([{ ...selected, side: "base" }, selected]);
  expect(lens.wholeFiles).toBe(false);
  expect(coverageProgress(result.files, lens.sources).total).toEqual({
    additions: 1,
    deletions: 1,
  });
  expect(coverageProgress(result.files, rest.sources).total).toEqual({
    additions: 2,
    deletions: 2,
  });
  expect(rest.wholeFiles).toBe(false);
  store.updateViewedCoverage(
    reviewId,
    result.files.map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
      scope: scopedCoverage(file, lens.sources),
    })),
    true,
  );
  const viewed = await reviewProgress(store, data, store.read(reviewId));
  expect(coverageProgress(viewed.files, lens.sources).state).toBe("viewed");
  expect(coverageProgress(viewed.files, rest.sources).remaining).toEqual({
    additions: 2,
    deletions: 2,
  });
  await writeLens(reviewId, {
    type: "update",
    targetId: lensId,
    title: "Stale selection",
    targets: [
      {
        kind: "ranges",
        sources: [
          {
            file: selected.file,
            start: { side: "head", line: 99 },
            end: { side: "head", line: 100 },
          },
        ],
      },
    ],
  });
  const stale = await reviewProgress(store, data, store.read(reviewId));
  expect(stale.lenses[0].unavailable).toBeTruthy();
  expect(
    coverageProgress(stale.files, stale.lenses.at(-1)!.sources).total,
  ).toEqual({ additions: 3, deletions: 3 });
});

it("rejects document lenses, unsafe patterns and missing range sources", async () => {
  const { reviewId } = await create();

  // Lenses left the document: an insert says where they went.
  for (const content of [
    {
      type: "file_lens",
      title: "Old",
      targets: [{ kind: "files", patterns: ["**"] }],
    },
    {
      type: "section",
      title: "Nested",
      children: [{ type: "file_lens", title: "Old", patterns: ["**"] }],
    },
  ])
    expect(() => edit(reviewId, { type: "insert", content })).toThrow(
      /no longer a document block.*session_lens_edit/,
    );

  await expect(
    writeLens(reviewId, {
      type: "insert",
      title: "Outside",
      targets: [{ kind: "files", patterns: ["../secrets/**"] }],
    }),
  ).rejects.toThrow(/repository-relative/);
  vi.mocked(providers.validateSource).mockRejectedValue(
    new Error("File is unavailable"),
  );
  await expect(
    writeLens(reviewId, {
      type: "insert",
      title: "Missing",
      targets: [{ kind: "ranges", sources: [selectSource(source)] }],
    }),
  ).rejects.toThrow("File is unavailable");
  expect(store.read(reviewId).lenses).toBeUndefined();
});

it("returns coverage and lenses after initial files without requesting summary events", async () => {
  const { reviewProgress } = await import("./review-progress.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  const file = { rhs: { path: "a.ts", oid: "head", mode: "100644" } };
  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "empty_tree" },
      rhs: { type: "revision", rev: "head" },
      files: [{ file, status: "added" }],
    };
    yield {
      type: "file",
      file,
      diff: {
        type: "text",
        rhs: { text: "added" },
        structural_changes: { base: [], head: [[0, 1]] },
        stats: {
          textual: { added: 1, removed: 0 },
          visible: { added: 0, removed: 0 },
        },
      },
    };
    throw new Error("Coverage must not await enrichment");
  });
  const progress = await reviewProgress(store, data, store.read(reviewId));
  expect(progress.files[0].changed).toEqual({ base: [], head: [[0, 1]] });
  expect(
    progress.lenses.find((lens) => lens.id === "automatic-uncategorized")
      ?.sources,
  ).toEqual([{ side: "head", file: "a.ts", fromLine: 1, toLine: 1 }]);
  data.close();
});

it("returns pending progress without waiting for coverage and signals completion to late watchers", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (
    _pins: typeof pins,
    file?: string,
  ) => {
    await gate;

    return file ? "" : [];
  }) as typeof data.changes);
  const api = createReviewApi(store, data);
  const route = `/${reviewId}/progress?version=0&mode=textual&wait=false`;

  try {
    const pending = await api.request(route);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ complete: false, files: [] });
    expect(data.coverageRevision).toBe(0);
    release();
    await data.coverage(reviewId, pins, "textual");
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));

    const watch = await api.request(
      `/watch?subscriptions=${encodeURIComponent(JSON.stringify([{ reviewId, mode: "textual" }]))}`,
    );

    const reader = watch.body!.getReader();

    const initial = JSON.parse(
      new TextDecoder().decode((await reader.read()).value),
    );

    expect(initial[0].value.coverageRevision).toBeGreaterThan(0);
    await reader.cancel();
    const ready = await api.request(route);
    expect(ready.status).toBe(200);
    expect((await ready.json()).files).toEqual([]);
    expect(data.changes).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await data.close();
  }
});

it("reports failed background coverage instead of leaving progress pending", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "changes").mockRejectedValue(new Error("comparison failed"));
  const api = createReviewApi(store, data);
  const route = `/${reviewId}/progress?version=0&mode=textual&wait=false`;

  try {
    expect((await api.request(route)).status).toBe(202);
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));
    expect((await api.request(route)).status).toBe(500);
  } finally {
    await data.close();
  }
});

it("logs a provider failure and names its kind without returning its local detail", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));

  const failure = Object.assign(
    new Error("EACCES: permission denied, open '/Users/someone/secret.ts'"),
    { code: "EACCES" },
  );

  vi.spyOn(data, "changes").mockRejectedValue(failure);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const api = createReviewApi(store, data);
  const route = `/${reviewId}/progress?version=0&mode=textual&wait=false`;

  try {
    await api.request(route);
    await vi.waitFor(() => expect(data.coverageRevision).toBeGreaterThan(0));
    const response = await api.request(route);
    expect(response.status).toBe(500);
    const { error } = await response.json();
    expect(error).toContain("EACCES");
    expect(error).toContain("main.log");
    expect(error).not.toContain("/Users/someone");
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`/${reviewId}/progress`),
      failure,
    );
  } finally {
    logged.mockRestore();
    await data.close();
  }
});

it("makes a diagram step's selection usable before an unrelated file finishes counting", async () => {
  const { createReviewApi } = await import("./http.js");
  const { selectionKey } = await import("../lens-selection.js");
  const { reviewId } = await create();

  const refs = ["a.ts", "b.ts"].map((file) =>
    selectSource({ side: "head", file, fromLine: 1, toLine: 1 }),
  );

  await edit(reviewId, {
    type: "insert",
    content: {
      ...diagram,
      steps: refs.map((source, i) => ({
        from: "app",
        to: "db",
        label: `step ${i}`,
        source,
      })),
    },
  });
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));
  vi.spyOn(data, "changes").mockImplementation((async (
    _pins: typeof pins,
    file?: string,
  ) => {
    if (!file)
      return ["a.ts", "b.ts"].map((path) => ({
        path,
        status: "modified",
        additions: 1,
        deletions: 1,
      }));

    if (file === "b.ts") await gate;

    return "@@ -1 +1 @@\n-old\n+new\n";
  }) as typeof data.changes);
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: side === "head" ? "new" : "old",
  }));
  const api = createReviewApi(store, data);
  const route = `/${reviewId}/progress?version=${store.read(reviewId).version}&mode=textual&wait=false`;

  try {
    await api.request(route);
    await vi.waitFor(() =>
      expect(
        data.coverageSnapshot(reviewId, pins, "textual").comparison.files,
      ).toHaveLength(1),
    );
    const partial = await (await api.request(route)).json();
    expect(partial.complete).toBe(false);
    // A diagram is not a Diff-view lens: only the automatic lens is listed.
    expect(partial.lenses).toHaveLength(1);
    expect(partial.resolvedSelections[selectionKey(refs[0])]).toBeDefined();
    expect(partial.resolvedSelections[selectionKey(refs[1])]).toBeUndefined();
    expect(partial.unavailableSelections).toEqual({});
    expect(partial.lenses.at(-1)).toMatchObject({
      id: "automatic-uncategorized",
      pending: true,
      sources: [],
    });
    release();
    await data.coverage(reviewId, pins, "textual");
    const complete = await (await api.request(route)).json();
    expect(complete.complete).toBe(true);
    expect(complete.lenses[0].pending).toBe(false);
    expect(complete.resolvedSelections[selectionKey(refs[1])]).toBeDefined();
  } finally {
    release();
    await data.close();
  }
});

it("Home reads persisted counts without scheduling comparisons, and changed pins start unknown", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  const comparison = vi.spyOn(data, "coverage");
  const api = createReviewApi(store, data);
  expect((await (await api.request("/")).json())[0].diffStats).toBeNull();
  expect(comparison).not.toHaveBeenCalled();
  const counts = { fileCount: 2, additions: 9, deletions: 3 };
  store.setDiffStats(pins, counts, "structural");
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.list()[0].diffStats).toEqual(counts);
  expect(store.list("textual")[0].diffStats).toBeNull();
  await store.execute(
    request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
  );
  expect(store.list()[0].diffStats).toBeNull();
  await store.execute(request({ type: "repin", reviewId, pins }));
  expect(store.list()[0].diffStats).toEqual(counts);
});

it("shares pending comparison work even when more than 32 reviews are opened", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    await gate;
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [],
    };
    yield { type: "complete", succeeded: 0, failed: 0 };
  });
  const first = data.coverage(reviewId, pins, "structural");

  const others = Array.from({ length: 33 }, (_, i) =>
    data.coverage(reviewId, { ...pins, head: `head-${i}` }, "structural"),
  );

  expect(data.coverage(reviewId, pins, "structural")).toBe(first);
  release();
  await Promise.all([first, ...others]);
});
