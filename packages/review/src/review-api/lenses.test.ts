import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { selectSource } from "../lens-selection.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import { ReviewApiClient } from "./client.js";
import { documentText } from "./document-text.js";
import { createReviewApi } from "./http.js";
import { LocalReviewData } from "./local-data.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

let directory: string, database: string, store: ReviewStore;

let providers: ReviewProviders;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-lenses-"));
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

const run = <Operation>(operation: Operation, leaseId?: string) =>
  store.execute({ commandId: randomUUID(), leaseId, operation });

const create = () => run({ type: "create", title: "Lenses", pins });

const lens = <Edit>(reviewId: string, edit: Edit, leaseId?: string) =>
  run({ type: "lens", reviewId, edit }, leaseId);

const markdown = (reviewId: string, text: string, leaseId?: string) =>
  run(
    {
      type: "edit",
      reviewId,
      edit: { type: "insert", content: { type: "markdown", markdown: text } },
    },
    leaseId,
  );

const files = (...patterns: string[]) => [{ kind: "files", patterns }];

it("inserts, updates and removes one lens at a time beside the document", async () => {
  const { reviewId } = await create();
  await markdown(reviewId, "Why this change");

  const api = await lens(reviewId, {
    type: "insert",
    title: "API",
    targets: files("src/api/**"),
  });

  expect(api).toMatchObject({ targetId: "lens-2", type: "lens" });
  expect(store.read(reviewId).lastEdit).toEqual({
    type: "insert",
    targetId: "lens-2",
    blockId: "lens-2",
    kind: "lens",
  });

  const tests = await lens(reviewId, {
    type: "insert",
    title: "Tests",
    targets: files("**/*.test.ts"),
  });

  const docs = await lens(reviewId, {
    type: "insert",
    title: "Docs",
    targets: files("docs/**"),
    afterId: api.targetId,
  });

  expect(store.read(reviewId).lenses?.map((item) => item.title)).toEqual([
    "API",
    "Docs",
    "Tests",
  ]);

  await lens(reviewId, {
    type: "update",
    targetId: docs.targetId,
    title: "Documentation",
  });
  expect(store.read(reviewId).lenses?.[1]).toEqual({
    id: docs.targetId,
    title: "Documentation",
    targets: files("docs/**"),
  });
  expect(store.read(reviewId).lastEdit).toMatchObject({
    type: "update",
    targetId: docs.targetId,
    kind: "lens",
    fields: ["title"],
  });

  await lens(reviewId, { type: "remove", targetId: tests.targetId });
  const current = store.read(reviewId);
  expect(current.lenses?.map((item) => item.id)).toEqual([
    api.targetId,
    docs.targetId,
  ]);
  expect(current.lastEdit).toMatchObject({
    type: "remove",
    targetId: tests.targetId,
  });
  // The document never holds a lens; its outline lists them for their ids.
  expect(current.document).toHaveLength(1);
  expect(documentText(current)).toContain(`[${docs.targetId}] Documentation`);

  await expect(
    lens(reviewId, { type: "update", targetId: "lens-99", title: "Nope" }),
  ).rejects.toThrow(/does not exist/);
  await expect(
    lens(reviewId, { type: "update", targetId: api.targetId }),
  ).rejects.toThrow(/title or targets/);
});

it("keeps lenses in history, restores them, and replays a lens command's receipt", async () => {
  const { reviewId } = await create();

  const command = {
    commandId: randomUUID(),
    operation: {
      type: "lens",
      reviewId,
      edit: { type: "insert", title: "API", targets: files("src/**") },
    },
  };

  const first = await store.execute(command);
  expect(await store.execute(command)).toEqual(first);

  await lens(reviewId, { type: "remove", targetId: first.targetId });
  expect(store.read(reviewId).lenses).toBeUndefined();
  expect(store.read(reviewId, first.version).lenses).toHaveLength(1);

  await run({ type: "restore", reviewId, version: first.version });
  expect(store.read(reviewId).lenses).toEqual([
    { id: first.targetId, title: "API", targets: files("src/**") },
  ]);
});

it("validates a lens's pinned ranges like any other source link", async () => {
  const { reviewId } = await create();
  const range = { side: "head" as const, file: "a.ts", fromLine: 2, toLine: 4 };

  await lens(reviewId, {
    type: "insert",
    title: "Range",
    targets: [{ kind: "ranges", sources: [selectSource(range)] }],
  });
  expect(providers.validateSource).toHaveBeenCalledWith(pins, range, {
    peek: false,
  });
});

it("lets a lenses lease write lenses while another session holds the document", async () => {
  const { reviewId } = await create();

  const writer = randomUUID(),
    lensWriter = randomUUID();

  store.activity.update(reviewId, { action: "begin", leaseId: writer });
  expect(
    store.activity.update(reviewId, {
      action: "begin",
      leaseId: lensWriter,
      scope: "lenses",
      focus: { description: "Grouping the API files", targetId: "lens-1" },
    }),
  ).toMatchObject({
    workingCount: 2,
    scopes: ["document", "lenses"],
    focuses: [
      {
        description: "Grouping the API files",
        targetId: "lens-1",
        scope: "lenses",
      },
    ],
  });

  // Each writes in its own scope, concurrently.
  await Promise.all([
    markdown(reviewId, "Overview", writer),
    lens(
      reviewId,
      { type: "insert", title: "API", targets: files("src/**") },
      lensWriter,
    ),
  ]);
  expect(store.read(reviewId).document).toHaveLength(1);
  expect(store.read(reviewId).lenses).toHaveLength(1);

  // Neither lease writes the other's scope, and no lease writes neither.
  await expect(markdown(reviewId, "Not mine", lensWriter)).rejects.toThrow(
    /another session/,
  );
  await expect(
    lens(
      reviewId,
      { type: "insert", title: "Docs", targets: files("docs/**") },
      writer,
    ),
  ).rejects.toThrow(/lenses are being authored by another session/);
  await expect(
    lens(reviewId, {
      type: "insert",
      title: "Docs",
      targets: files("docs/**"),
    }),
  ).rejects.toThrow(/another session/);
  await expect(markdown(reviewId, "Anonymous")).rejects.toThrow(
    /another session/,
  );

  // A lens write needs the lenses lease itself, not the document's.
  store.activity.update(reviewId, {
    action: "end",
    leaseId: lensWriter,
    scope: "lenses",
  });
  await expect(
    lens(
      reviewId,
      { type: "insert", title: "Docs", targets: files("docs/**") },
      writer,
    ),
  ).rejects.toThrow(/No live lenses lease/);
  expect(store.activity.read(reviewId)).toMatchObject({
    workingCount: 1,
    scopes: ["document"],
  });
});

it("renews only the lease whose scope a write lands in", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { reviewId } = await create();

  const writer = randomUUID(),
    lensWriter = randomUUID();

  store.activity.update(reviewId, { action: "begin", leaseId: writer });
  store.activity.update(reviewId, {
    action: "begin",
    leaseId: lensWriter,
    scope: "lenses",
  });
  vi.advanceTimersByTime(120_000);
  await lens(
    reviewId,
    { type: "insert", title: "API", targets: files("src/**") },
    lensWriter,
  );
  vi.advanceTimersByTime(90_000);

  // The document lease lapsed; the lens write kept the lenses lease alive.
  expect(store.activity.read(reviewId)).toMatchObject({
    workingCount: 1,
    scopes: ["lenses"],
  });
});

it("reads lenses saved as document blocks as the snapshot's lenses", async () => {
  const { reviewId, version } = await create();

  const legacy = [
    { type: "markdown", id: "markdown-1", markdown: "Intro" },
    {
      type: "file_lens",
      id: "files-2",
      title: "Tests",
      patterns: ["**/*.test.ts"],
    },
    {
      type: "section",
      id: "section-3",
      title: "Details",
      children: [
        {
          type: "file_lens",
          id: "files-4",
          title: "API",
          targets: [{ kind: "files", patterns: ["src/api/**"] }],
        },
        { type: "markdown", id: "markdown-5", markdown: "More" },
      ],
    },
  ];

  const db = new DatabaseSync(database);
  db.prepare(
    "UPDATE versions SET snapshot=json_set(snapshot,'$.document',json(?)) WHERE review_id=? AND version=?",
  ).run(JSON.stringify(legacy), reviewId, version);
  db.prepare("UPDATE reviews SET next_id=5 WHERE id=?").run(reviewId);
  db.close();

  const read = store.read(reviewId);
  expect(read.lenses).toEqual([
    { id: "files-2", title: "Tests", targets: files("**/*.test.ts") },
    { id: "files-4", title: "API", targets: files("src/api/**") },
  ]);
  expect(JSON.stringify(read.document)).not.toContain("file_lens");
  expect(read.document.map((block) => block.id)).toEqual([
    "markdown-1",
    "section-3",
  ]);

  // The next write saves them beside the document, ids and all.
  await lens(reviewId, {
    type: "update",
    targetId: "files-4",
    targets: files("src/api/**", "src/server/**"),
  });
  const raw = new DatabaseSync(database);

  const saved = JSON.parse(
    String(
      raw
        .prepare(
          "SELECT snapshot FROM versions WHERE review_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(reviewId)!.snapshot,
    ),
  );

  raw.close();
  expect(JSON.stringify(saved.document)).not.toContain("file_lens");
  expect(saved.lenses.map((item: { id: string }) => item.id)).toEqual([
    "files-2",
    "files-4",
  ]);
});

it("keeps a live lease from before scopes as the document's", async () => {
  await store.close();
  const legacyPath = path.join(directory, "legacy.db");
  const db = new DatabaseSync(legacyPath);
  db.exec(`CREATE TABLE authoring_sessions(
      review_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, focus TEXT
    )`);
  const leaseId = randomUUID();
  db.prepare("INSERT INTO authoring_sessions VALUES(?,?,?,?)").run(
    "review",
    leaseId,
    Date.now() + 60_000,
    JSON.stringify({ description: "Writing" }),
  );
  db.close();

  store = new ReviewStore(legacyPath, providers);
  expect(store.activity.read("review")).toMatchObject({
    workingCount: 1,
    scopes: ["document"],
    focuses: [{ description: "Writing" }],
  });
  expect(store.activity.heldByAnother("review", leaseId)).toBe(false);
  expect(store.activity.heldByAnother("review", leaseId, "lenses")).toBe(false);
});

it("reports the changed lines no lens selects after each lens write", async () => {
  const { reviewId } = await create();
  const data = new LocalReviewData(store);
  vi.spyOn(data, "resolveSource").mockImplementation(async (snapshot) => ({
    snapshot,
    pins: snapshot.pins!,
  }));

  const changed = (path: string, text: string) => ({
    file: {
      lhs: { path, oid: "base", mode: "100644" },
      rhs: { path, oid: "head", mode: "100644" },
    },
    text,
  });

  const api = changed("src/api.ts", "one\ntwo"),
    readme = changed("docs/readme.md", "intro");

  vi.spyOn(data, "structuralChanges").mockImplementation(async function* () {
    yield {
      type: "start",
      version: 4,
      lhs: { type: "revision", rev: "base" },
      rhs: { type: "revision", rev: "head" },
      files: [api, readme].map(({ file }) => ({ file, status: "modified" })),
    };

    for (const { file, text } of [api, readme])
      yield {
        type: "file",
        file,
        diff: {
          type: "text",
          lhs: { text },
          rhs: { text },
          structural_changes: {
            base: [[0, text.split("\n").length]],
            head: [[0, text.split("\n").length]],
          },
          stats: {
            textual: { added: 1, removed: 1 },
            visible: { added: 0, removed: 0 },
          },
        },
      };
    yield { type: "complete", succeeded: 2, failed: 0 };
  });
  vi.spyOn(data, "file").mockImplementation(async (_pins, side, file) => ({
    file,
    side,
    commit: _pins[side],
    text: file === "src/api.ts" ? api.text : readme.text,
  }));

  const app = createReviewApi(store, data);

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "token" },
    async (url, init) =>
      app.request(String(url).replace("http://review/reviews-api", ""), init),
  );

  const tools = await client.read<AuthoringTool[]>("/authoring");

  const call = (name: string, input: Parameters<typeof callAuthoringTool>[2]) =>
    callAuthoringTool(client, tools.find((tool) => tool.name === name)!, {
      reviewId,
      ...input,
    });

  try {
    expect(
      await call("review_lens_edit", {
        commandId: randomUUID(),
        edit: { type: "insert", title: "API", targets: files("src/**") },
      }),
    ).toMatchObject({
      targetId: "lens-1",
      type: "lens",
      uncategorized: {
        lines: 2,
        files: [
          {
            path: "docs/readme.md",
            lines: 2,
            ranges: [
              { side: "base", fromLine: 1, toLine: 1 },
              { side: "head", fromLine: 1, toLine: 1 },
            ],
          },
        ],
      },
    });

    expect(
      await call("review_lens_edit", {
        commandId: randomUUID(),
        edit: { type: "insert", title: "Docs", targets: files("docs/**") },
      }),
    ).toMatchObject({ uncategorized: { lines: 0, files: [] } });

    expect(await call("review_lens_get", {})).toMatchObject({
      lenses: [
        { id: "lens-1", title: "API", fileCount: 1 },
        { id: "lens-2", title: "Docs", fileCount: 1 },
      ],
      uncategorized: { lines: 0 },
    });
  } finally {
    await data.close();
  }
});
