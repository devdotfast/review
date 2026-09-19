import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "../server/desktop-server.js";
import { GlobalReviewDesktopVerbRelay } from "../server/global-verb-relay.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { documentText } from "./document-text.js";
import { ReviewInputError } from "./document.js";
import { LocalReviewData } from "./local-data";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const source = { side: "head", file: "src/store.ts", fromLine: 1, toLine: 5 };

const diagram = {
  type: "sequence",
  title: "Save",
  actors: { app: "App", db: "Database" },
  steps: [{ from: "app", to: "db", label: "Write", source }],
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
        base: [{ key: "mouse", label: "selectionchange", source }],
        head: [{ key: "keyboard", label: "keydown", source }],
      },
    });
    const saved = store.read(reviewId).document[0]!;
    expect(saved).toMatchObject({
      type: "call_stack_diff",
      base: [{ source }],
      head: [{ source }],
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
    { type: "code_peek", source },
    diagram,
    {
      type: "call_stack_diff",
      title: "Change",
      base: [{ source: { ...source, side: "base" } }],
      head: [{ source }],
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
              source,
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
      content: { type: "code_peek", source },
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
      changes: { source: { ...source, file: "renamed.ts" } },
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
      content: { type: "code_peek", source },
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
      content: { type: "code_peek", source },
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
      source,
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
        content: { type: "code_peek", source: { ...source, fromLine: 10 } },
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
        content: { type: "code_peek", source },
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
        steps: [{ from: "a", to: "s", label: "save", source }],
      },
      {
        type: "call_stack_diff",
        title: "Save path",
        base: [],
        head: [{ key: "save", label: "save", source }],
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
                source,
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
      content: { type: "code_peek", source },
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

it("serves the experiment through the real desktop HTTP server and existing authentication", async () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  const relay = new GlobalReviewDesktopVerbRelay();

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
    const { reviewId } = await response.json();
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
        { side: "head", message: "Repository is not registered." },
        { side: "base", message: "Repository is not registered." },
      ],
    });

    relay.close();

    expect(
      await callAuthoringTool(
        client,
        tools.find((t) => t.name === "review_list")!,
        {},
      ),
    ).toMatchObject([{ reviewId }]);
    await expect(
      callAuthoringTool(client, tools.find((t) => t.name === "review_edit")!, {
        commandId: randomUUID(),
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: { side: "head", file: "x", fromLine: 0, toLine: 1 },
          },
        },
      }),
    ).rejects.toThrow(/fromLine/);
    const abort = new AbortController();
    const catalog = client.watch(null, abort.signal);
    expect((await catalog.next()).value).toMatchObject([
      { reviewId, dismissedAt: null },
    ]);
    await post({ type: "attention", reviewId, action: "dismiss" });
    expect((await catalog.next()).value).toMatchObject([
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

it("preserves unfinished section status after authoring stops and restores it from history", async () => {
  const { reviewId } = await create();

  const inserted = await edit(reviewId, {
    type: "insert",
    content: {
      type: "section",
      title: "Design",
      status: "pending",
      children: [],
    },
  });

  const leaseId = randomUUID();
  store.activity.update(reviewId, { action: "begin", leaseId });

  const started = await edit(reviewId, {
    type: "update",
    targetId: inserted.targetId,
    changes: { status: "in_progress" },
  });

  store.activity.update(reviewId, { action: "end", leaseId });
  await store.close();
  store = new ReviewStore(database, providers);
  expect(store.read(reviewId).document[0]).toMatchObject({
    id: inserted.targetId,
    status: "in_progress",
  });
  expect(documentText(store.read(reviewId))).toContain("Status: in_progress");
  expect(store.read(reviewId, inserted.version).document[0]).toMatchObject({
    status: "pending",
  });
  await edit(reviewId, {
    type: "update",
    targetId: inserted.targetId,
    changes: { status: "complete" },
  });
  expect(store.read(reviewId).document[0]).toMatchObject({
    status: "complete",
  });
  await expect(
    edit(reviewId, {
      type: "update",
      targetId: inserted.targetId,
      changes: { status: "done" },
    }),
  ).rejects.toThrow(/Invalid/);
  expect(store.read(reviewId).document[0]).toMatchObject({
    status: "complete",
  });
  await store.execute(
    request({ type: "restore", reviewId, version: started.version }),
  );
  expect(store.read(reviewId).document[0]).toMatchObject({
    status: "in_progress",
  });
  await edit(reviewId, {
    type: "update",
    targetId: inserted.targetId,
    changes: { status: null },
  });
  expect(store.read(reviewId).document[0]).not.toHaveProperty("status");
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

it("preserves unchanged partial file coverage across pins and rejects stale writes after either file side changes", async () => {
  const { createReviewApi } = await import("./http.js");
  const { reviewProgress } = await import("./review-progress.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  let head = "first\nsecond\ncontext";
  let base = "first\nold\ncontext";
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins,
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
            sources: [{ side: "head", file: "a.ts", fromLine: 2, toLine: 2 }],
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
    pins: snapshot.pins,
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
  expect(structural).not.toHaveBeenCalled();
});

it("resolves file lenses to whole changed files, preserves empty groups, and shares viewed coverage", async () => {
  const { reviewProgress } = await import("./review-progress.js");
  const { coverageProgress } = await import("../viewed-coverage.js");
  const { reviewId } = await create();

  for (const content of [
    { type: "file_lens", title: "Docs", patterns: ["docs/**", "docs/old.md"] },
    { type: "file_lens", title: "Guide", patterns: ["guide/**"] },
    { type: "file_lens", title: "Tests", patterns: ["**/*.test.ts"] },
  ])
    await store.execute(
      request({ type: "edit", reviewId, edit: { type: "insert", content } }),
    );
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins,
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
  const [docs, guide, tests] = initial.diagrams;
  expect(docs.fileCount).toBe(1);
  expect(docs.sources).toEqual([
    { side: "base", file: "docs/old.md", fromLine: 1, toLine: 3 },
    { side: "head", file: "guide/intro.md", fromLine: 1, toLine: 3 },
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
  await edit(reviewId, {
    type: "insert",
    content: {
      type: "file_lens",
      title: "One line",
      targets: [{ kind: "ranges", sources: [selected, selected] }],
    },
  });
  expect(providers.validateSource).toHaveBeenCalledWith(
    pins,
    selected,
    expect.anything(),
  );
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins,
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
  const lens = result.diagrams[0],
    rest = result.diagrams.find(
      (lens) => lens.id === "automatic-uncategorized",
    )!;
  expect(lens.sources).toEqual([selected]);
  expect(lens.wholeFiles).toBe(false);
  expect(coverageProgress(result.files, lens.sources).total).toEqual({
    additions: 1,
    deletions: 0,
  });
  expect(coverageProgress(result.files, rest.sources).total).toEqual({
    additions: 2,
    deletions: 3,
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
    deletions: 3,
  });
  vi.spyOn(data, "quote").mockRejectedValue(new Error("Stale range"));
  const stale = await reviewProgress(store, data, store.read(reviewId));
  expect(stale.diagrams[0].unavailable).toBeTruthy();
  expect(
    coverageProgress(stale.files, stale.diagrams.at(-1)!.sources).total,
  ).toEqual({ additions: 3, deletions: 3 });
});

it("rejects ambiguous lens scopes and validates range sources during authoring", async () => {
  const { reviewId } = await create();
  for (const scope of [
    {},
    { patterns: ["**"], targets: [{ kind: "files", patterns: ["**"] }] },
  ])
    await expect(
      edit(reviewId, {
        type: "insert",
        content: { type: "file_lens", title: "Invalid", ...scope },
      }),
    ).rejects.toThrow(/either targets or legacy patterns/);
  vi.mocked(providers.validateSource).mockRejectedValue(
    new Error("File is unavailable"),
  );
  await expect(
    edit(reviewId, {
      type: "insert",
      content: {
        type: "file_lens",
        title: "Missing",
        targets: [{ kind: "ranges", sources: [source] }],
      },
    }),
  ).rejects.toThrow("File is unavailable");
});

it("returns coverage and lenses after initial files without requesting summary events", async () => {
  const { reviewProgress } = await import("./review-progress.js");
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins,
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
    progress.diagrams.find((lens) => lens.id === "automatic-uncategorized")
      ?.sources,
  ).toEqual([{ side: "head", file: "a.ts", fromLine: 1, toLine: 1 }]);
  data.close();
});
