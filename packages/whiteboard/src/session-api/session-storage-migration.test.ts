import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import { migrateSessionStorage } from "./session-storage-migration";
import { SessionStore } from "./store";

const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function legacy() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE reviews(id TEXT PRIMARY KEY,version INTEGER,next_id INTEGER);
    CREATE TABLE versions(review_id TEXT REFERENCES reviews(id),version INTEGER,snapshot TEXT,PRIMARY KEY(review_id,version));
    CREATE TABLE receipts(command_id TEXT PRIMARY KEY,request TEXT,response TEXT);
    CREATE TABLE review_attention(review_id TEXT PRIMARY KEY REFERENCES reviews(id),viewed_at TEXT);
    CREATE TABLE authoring_sessions(review_id TEXT PRIMARY KEY,lease_id TEXT,expires_at INTEGER);
    INSERT INTO reviews VALUES('saved',2,7);
    INSERT INTO review_attention VALUES('saved','yesterday');
    INSERT INTO authoring_sessions VALUES('saved','lease',123);`);

  return db;
}

it("carries identities, history, references and receipts forward without rewriting authored fields", () => {
  const db = legacy();

  const document = [
    {
      type: "markdown",
      markdown: "reviewId stays in user text",
      reviewId: "authored",
    },
  ];

  const snapshot = { reviewId: "saved", version: 2, document };

  for (const version of [1, 2])
    db.prepare("INSERT INTO versions VALUES(?,?,?)").run(
      "saved",
      version,
      JSON.stringify({ ...snapshot, version }),
    );
  const operation = { type: "edit", reviewId: "saved", edit: { document } };
  db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
    "retry",
    JSON.stringify({ commandId: "retry", operation }),
    JSON.stringify({ reviewId: "saved", version: 2 }),
  );
  db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
    "deleted",
    "null",
    JSON.stringify({ reviewId: "deleted", deleted: true }),
  );
  migrateSessionStorage(db);
  migrateSessionStorage(db);
  expect(db.prepare("SELECT * FROM sessions").get()).toMatchObject({
    id: "saved",
    version: 2,
    next_id: 7,
  });

  const versions = db
    .prepare("SELECT snapshot FROM versions ORDER BY version")
    .all()
    .map((row) => JSON.parse(String(row.snapshot)));

  expect(versions).toEqual(
    [1, 2].map((version) => ({ sessionId: "saved", version, document })),
  );
  expect(db.prepare("SELECT * FROM session_attention").get()).toMatchObject({
    session_id: "saved",
    viewed_at: "yesterday",
  });
  expect(db.prepare("SELECT * FROM authoring_sessions").get()).toMatchObject({
    session_id: "saved",
    lease_id: "lease",
    expires_at: 123,
  });

  const receipt = db
    .prepare("SELECT * FROM receipts WHERE command_id='retry'")
    .get()!;

  expect(JSON.parse(String(receipt.request))).toEqual({
    commandId: "retry",
    operation: { type: "edit", sessionId: "saved", edit: { document } },
  });
  expect(JSON.parse(String(receipt.response))).toEqual({
    sessionId: "saved",
    version: 2,
  });
  expect(
    db.prepare("SELECT request FROM receipts WHERE command_id='deleted'").get()
      ?.request,
  ).toBe("null");
  expect(() =>
    db.prepare("INSERT INTO versions VALUES('missing',1,'{}')").run(),
  ).toThrow("FOREIGN KEY constraint failed");
});

it("rolls back schema and data if an existing snapshot is malformed", () => {
  const db = legacy();
  db.prepare("INSERT INTO versions VALUES('saved',1,?)").run("{broken");
  expect(() => migrateSessionStorage(db)).toThrow(SyntaxError);
  expect(db.prepare("SELECT id FROM reviews").get()?.id).toBe("saved");
  expect(
    db.prepare("SELECT review_id,snapshot FROM versions").get(),
  ).toMatchObject({ review_id: "saved", snapshot: "{broken" });
});

it("leaves a fresh database ready for the new schema", () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  migrateSessionStorage(db);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
  ).toEqual([]);
});

it("upgrades on store startup, replays an old receipt and accepts a new edit after reopening", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "whiteboard-upgrade-"));
  const filename = path.join(dir, "store.db");
  const commandId = randomUUID();
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE reviews(id TEXT PRIMARY KEY,version INTEGER,next_id INTEGER);
    CREATE TABLE versions(review_id TEXT REFERENCES reviews(id),version INTEGER,snapshot TEXT,PRIMARY KEY(review_id,version));
    CREATE TABLE receipts(command_id TEXT PRIMARY KEY,request TEXT,response TEXT);
    INSERT INTO reviews VALUES('saved',1,1);`);
  db.prepare("INSERT INTO versions VALUES('saved',1,?)").run(
    JSON.stringify({
      reviewId: "saved",
      version: 1,
      title: "Kept",
      createdAt: "2026-09-01T00:00:00Z",
      document: [],
    }),
  );
  db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
    commandId,
    JSON.stringify({
      commandId,
      operation: { type: "rename", reviewId: "saved", title: "Kept" },
    }),
    JSON.stringify({ reviewId: "saved", version: 1 }),
  );
  db.close();

  let store = new SessionStore(filename, {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  try {
    expect(store.read("saved")).toMatchObject({
      sessionId: "saved",
      title: "Kept",
    });
    expect(
      await store.execute({
        commandId,
        operation: { type: "rename", sessionId: "saved", title: "Kept" },
      }),
    ).toEqual({ sessionId: "saved", version: 1 });
    expect(store.history("saved")).toHaveLength(1);
    await store.close();
    store = new SessionStore(filename, {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });
    await store.execute({
      commandId: randomUUID(),
      operation: { type: "rename", sessionId: "saved", title: "After upgrade" },
    });
    expect(store.read("saved")).toMatchObject({
      sessionId: "saved",
      title: "After upgrade",
      version: 2,
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
