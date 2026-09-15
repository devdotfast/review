import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "../server/desktop-server.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { ReviewInputError } from "./document.js";
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
  it("deletes one review and its history, keeps other reviews, and cannot replay deleted content", async () => {
    const input = request({ type: "create", title: "Delete me", pins });
    const { reviewId } = await store.execute(input);
    const other = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Private review text" },
    });
    await store.execute(
      request({
        type: "feedback",
        reviewId,
        action: {
          type: "post",
          threadId: "question",
          messageId: "message",
          version: 1,
          target: { kind: "document" },
          body: "Private question",
        },
      }),
    );
    const version = store.feedback.read(other.reviewId).revision;
    const deletion = request({ type: "delete", reviewId });
    const result = await store.execute(deletion);
    expect(result).toMatchObject({ reviewId, deleted: true });
    expect(await store.execute(deletion)).toEqual(result);
    expect(() => store.read(reviewId)).toThrow(/not found/);
    expect(store.history(reviewId)).toEqual([]);
    expect(() => store.feedback.read(reviewId)).toThrow(/not found/);
    expect(store.read(other.reviewId)).toMatchObject({
      version: 0,
      title: "Example",
    });
    expect(store.feedback.read(other.reviewId).revision).toBeGreaterThan(
      version,
    );
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
    await store.execute(
      request({
        type: "repin",
        reviewId: first.reviewId,
        pins: { ...pins, head: "new-head" },
      }),
    );
    expect(store.read(first.reviewId)).toMatchObject({
      document: [],
      pins: { head: "new-head" },
    });
    expect(store.read(second.reviewId)).toMatchObject({
      document: [],
      version: 0,
      pins,
    });
    expect(store.list()).toHaveLength(2);
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

  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "test-token",
    discoveryPath: path.join(directory, "desktop.json"),
    reviewStore: store,
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

    const feedback = client.watch(
      reviewId,
      new AbortController().signal,
      "feedback",
    );

    await feedback.next();
    await Promise.all([
      expect(watching.next()).rejects.toThrow(Error),
      expect(feedback.next()).rejects.toThrow(Error),
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
