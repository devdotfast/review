import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { selectSource } from "../lens-selection.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import { SessionApiClient } from "./client.js";
import { documentText } from "./document-text.js";
import { createSessionApi } from "./http.js";
import { LocalSessionData } from "./local-data.js";
import { type SessionProviders, SessionStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

let directory: string, database: string, store: SessionStore;

let providers: SessionProviders;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-lenses-"));
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  providers = {
    validatePins: vi.fn<SessionProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<SessionProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<SessionProviders["validateResource"]>(
      async () => {},
    ),
  };
  store = new SessionStore(database, providers);
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

const lens = <Edit>(sessionId: string, edit: Edit, leaseId?: string) =>
  run({ type: "lens", sessionId, edit }, leaseId);

const markdown = (sessionId: string, text: string, leaseId?: string) =>
  run(
    {
      type: "edit",
      sessionId,
      edit: { type: "insert", content: { type: "markdown", markdown: text } },
    },
    leaseId,
  );

const files = (...patterns: string[]) => [{ kind: "files", patterns }];

it("inserts, updates and removes one lens at a time beside the document", async () => {
  const { sessionId } = await create();
  await markdown(sessionId, "Why this change");

  const api = await lens(sessionId, {
    type: "insert",
    title: "API",
    targets: files("src/api/**"),
  });

  expect(api).toMatchObject({ targetId: "lens-2", type: "lens" });
  expect(store.read(sessionId).lastEdit).toEqual({
    type: "insert",
    targetId: "lens-2",
    blockId: "lens-2",
    kind: "lens",
  });

  const tests = await lens(sessionId, {
    type: "insert",
    title: "Tests",
    targets: files("**/*.test.ts"),
  });

  const docs = await lens(sessionId, {
    type: "insert",
    title: "Docs",
    targets: files("docs/**"),
    afterId: api.targetId,
  });

  expect(store.read(sessionId).lenses?.map((item) => item.title)).toEqual([
    "API",
    "Docs",
    "Tests",
  ]);

  await lens(sessionId, {
    type: "update",
    targetId: docs.targetId,
    title: "Documentation",
  });
  expect(store.read(sessionId).lenses?.[1]).toEqual({
    id: docs.targetId,
    title: "Documentation",
    targets: files("docs/**"),
  });
  expect(store.read(sessionId).lastEdit).toMatchObject({
    type: "update",
    targetId: docs.targetId,
    kind: "lens",
    fields: ["title"],
  });

  await lens(sessionId, { type: "remove", targetId: tests.targetId });
  const current = store.read(sessionId);
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
    lens(sessionId, { type: "update", targetId: "lens-99", title: "Nope" }),
  ).rejects.toThrow(/does not exist/);
  await expect(
    lens(sessionId, { type: "update", targetId: api.targetId }),
  ).rejects.toThrow(/title or targets/);
});

it("keeps lenses in history, restores them, and replays a lens command's receipt", async () => {
  const { sessionId } = await create();

  const command = {
    commandId: randomUUID(),
    operation: {
      type: "lens",
      sessionId,
      edit: { type: "insert", title: "API", targets: files("src/**") },
    },
  };

  const first = await store.execute(command);
  expect(await store.execute(command)).toEqual(first);

  await lens(sessionId, { type: "remove", targetId: first.targetId });
  expect(store.read(sessionId).lenses).toBeUndefined();
  expect(store.read(sessionId, first.version).lenses).toHaveLength(1);

  await run({ type: "restore", sessionId, version: first.version });
  expect(store.read(sessionId).lenses).toEqual([
    { id: first.targetId, title: "API", targets: files("src/**") },
  ]);
});

it("validates a lens's pinned ranges like any other source link", async () => {
  const { sessionId } = await create();
  const range = { side: "head" as const, file: "a.ts", fromLine: 2, toLine: 4 };

  await lens(sessionId, {
    type: "insert",
    title: "Range",
    targets: [{ kind: "ranges", sources: [selectSource(range)] }],
  });
  expect(providers.validateSource).toHaveBeenCalledWith(pins, range, {
    peek: false,
  });
});

it("lets a lenses lease write lenses while another session holds the document", async () => {
  const { sessionId } = await create();

  const writer = randomUUID(),
    lensWriter = randomUUID();

  store.activity.update(sessionId, { action: "begin", leaseId: writer });
  expect(
    store.activity.update(sessionId, {
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
    markdown(sessionId, "Overview", writer),
    lens(
      sessionId,
      { type: "insert", title: "API", targets: files("src/**") },
      lensWriter,
    ),
  ]);
  expect(store.read(sessionId).document).toHaveLength(1);
  expect(store.read(sessionId).lenses).toHaveLength(1);

  // Neither lease writes the other's scope, and no lease writes neither.
  await expect(markdown(sessionId, "Not mine", lensWriter)).rejects.toThrow(
    /another session/,
  );
  await expect(
    lens(
      sessionId,
      { type: "insert", title: "Docs", targets: files("docs/**") },
      writer,
    ),
  ).rejects.toThrow(/lenses are being authored by another session/);
  await expect(
    lens(sessionId, {
      type: "insert",
      title: "Docs",
      targets: files("docs/**"),
    }),
  ).rejects.toThrow(/another session/);
  await expect(markdown(sessionId, "Anonymous")).rejects.toThrow(
    /another session/,
  );

  // A lens write needs the lenses lease itself, not the document's.
  store.activity.update(sessionId, {
    action: "end",
    leaseId: lensWriter,
    scope: "lenses",
  });
  await expect(
    lens(
      sessionId,
      { type: "insert", title: "Docs", targets: files("docs/**") },
      writer,
    ),
  ).rejects.toThrow(/No live lenses lease/);
  expect(store.activity.read(sessionId)).toMatchObject({
    workingCount: 1,
    scopes: ["document"],
  });
});

it("renews only the lease whose scope a write lands in", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { sessionId } = await create();

  const writer = randomUUID(),
    lensWriter = randomUUID();

  store.activity.update(sessionId, { action: "begin", leaseId: writer });
  store.activity.update(sessionId, {
    action: "begin",
    leaseId: lensWriter,
    scope: "lenses",
  });
  vi.advanceTimersByTime(120_000);
  await lens(
    sessionId,
    { type: "insert", title: "API", targets: files("src/**") },
    lensWriter,
  );
  vi.advanceTimersByTime(90_000);

  // The document lease lapsed; the lens write kept the lenses lease alive.
  expect(store.activity.read(sessionId)).toMatchObject({
    workingCount: 1,
    scopes: ["lenses"],
  });
});

it("reads lenses saved as document blocks as the snapshot's lenses", async () => {
  const { sessionId, version } = await create();

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
    "UPDATE versions SET snapshot=json_set(snapshot,'$.document',json(?)) WHERE session_id=? AND version=?",
  ).run(JSON.stringify(legacy), sessionId, version);
  db.prepare("UPDATE sessions SET next_id=5 WHERE id=?").run(sessionId);
  db.close();

  const read = store.read(sessionId);
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
  await lens(sessionId, {
    type: "update",
    targetId: "files-4",
    targets: files("src/api/**", "src/server/**"),
  });
  const raw = new DatabaseSync(database);

  const saved = JSON.parse(
    String(
      raw
        .prepare(
          "SELECT snapshot FROM versions WHERE session_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(sessionId)!.snapshot,
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
      session_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
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

  store = new SessionStore(legacyPath, providers);
  expect(store.activity.read("review")).toMatchObject({
    workingCount: 1,
    scopes: ["document"],
    focuses: [{ description: "Writing" }],
  });
  expect(store.activity.heldByAnother("review", leaseId)).toBe(false);
  expect(store.activity.heldByAnother("review", leaseId, "lenses")).toBe(false);
});

it("reports the changed lines no lens selects after each lens write", async () => {
  const { sessionId } = await create();
  const data = new LocalSessionData(store);
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

  const app = createSessionApi(store, data);

  const client = new SessionApiClient(
    { serverUrl: "http://review", token: "token" },
    async (url, init) =>
      app.request(String(url).replace("http://review/sessions-api", ""), init),
  );

  const tools = await client.read<AuthoringTool[]>("/authoring");

  const call = (name: string, input: Parameters<typeof callAuthoringTool>[2]) =>
    callAuthoringTool(client, tools.find((tool) => tool.name === name)!, {
      sessionId,
      ...input,
    });

  try {
    expect(
      await call("session_lens_edit", {
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
      await call("session_lens_edit", {
        commandId: randomUUID(),
        edit: { type: "insert", title: "Docs", targets: files("docs/**") },
      }),
    ).toMatchObject({ uncategorized: { lines: 0, files: [] } });

    expect(await call("session_lens_get", {})).toMatchObject({
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
