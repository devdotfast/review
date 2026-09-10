import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type HostReview,
  type HostSourceRange,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  type HostCommandIdentity,
  type HostPreparedDocument,
  ReviewHostStore,
} from "./review-host-store.js";

const directories: string[] = [];
const connections = new Set<ReviewHostStore>();
afterEach(() => {
  for (const store of connections) store.close();
  connections.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore(databasePath: string): ReviewHostStore {
  const store = new ReviewHostStore(databasePath);
  connections.add(store);
  return store;
}

function closeStore(store: ReviewHostStore): void {
  store.close();
  connections.delete(store);
}

function directory(): string {
  const result = mkdtempSync(path.join(tmpdir(), "review-host-store-"));
  directories.push(result);
  return result;
}

function commandIdentity(
  request: JsonValue = { type: "test.command" },
): HostCommandIdentity {
  return { clientId: randomUUID(), commandId: randomUUID(), request };
}

function inspect<T>(databasePath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function changeDatabase(
  databasePath: string,
  change: (db: DatabaseSync) => void,
): void {
  const db = new DatabaseSync(databasePath);
  try {
    change(db);
  } finally {
    db.close();
  }
}

function persistenceCounts(databasePath: string) {
  return inspect(databasePath, (db) =>
    db
      .prepare(`SELECT
    (SELECT count(*) FROM host_content_objects) AS objects,
    (SELECT count(*) FROM host_document_versions) AS versions,
    (SELECT count(*) FROM host_document_object_refs) AS refs,
    (SELECT count(*) FROM host_document_ids) AS ids,
    (SELECT count(*) FROM host_events) AS events,
    (SELECT count(*) FROM host_command_receipts) AS receipts`)
      .get(),
  );
}

function preparedDocument(
  repositoryId: string,
  prose = "Initial explanation",
): HostPreparedDocument {
  const now = "2026-09-10T12:00:00Z";
  const source: HostSourceRange = {
    side: "head",
    file: "src/database.ts",
    fromLine: 1,
    toLine: 1,
  };
  const sourceText = "export const shared = true;";
  return {
    document: {
      schemaVersion: 1,
      roots: ["intro", "database"],
      nodes: {
        intro: { id: "intro", type: "markdown", markdown: prose },
        database: { id: "database", type: "code_peek", anchorId: "database" },
      },
      definitions: {
        database: { kind: "anchor", title: "Shared database", source },
      },
    },
    binding: {
      id: randomUUID(),
      repositoryId,
      selector: { kind: "range", baseRef: "main", headRef: "feature/review" },
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
      createdAt: now,
    },
    evidence: {
      database: {
        span: {
          repositoryId,
          commit: "2".repeat(40),
          blob: "3".repeat(40),
          file: source.file,
          fromLine: 1,
          toLine: 1,
        },
        text: sourceText,
        sha256: createHash("sha256").update(sourceText).digest("hex"),
      },
    },
  };
}

function newReview(repositoryId: string): HostReview {
  const now = "2026-09-10T12:00:00Z";
  return {
    id: randomUUID(),
    repositoryId,
    version: 0,
    title: "Local review",
    description: "",
    labels: [],
    workflow: "draft",
    documentId: randomUUID(),
    documentVersion: 0,
    publishedCheckpointId: null,
    authorSessionId: null,
    createdBy: randomUUID(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function fixture() {
  const root = directory();
  const databasePath = path.join(root, "review.db");
  const store = openStore(databasePath);
  const repositoryId = randomUUID();
  store.command(commandIdentity({ type: "repository.register" }), () => {
    store.registerRepository({
      id: repositoryId,
      displayName: "Review",
      vcs: "git",
      localPath: path.join(root, "repository"),
    });
    return { repositoryId };
  });
  const review = newReview(repositoryId);
  const prepared = preparedDocument(repositoryId);
  const created = store.command(
    commandIdentity({ type: "review.create", reviewId: review.id }),
    () => {
      const document = store.createReview(review, prepared);
      store.appendEvent(review.id, "review.created", {
        reviewId: review.id,
        version: document.version,
      });
      return document;
    },
  );
  return { root, databasePath, store, repositoryId, review, prepared, created };
}

function edit(
  prepared: HostPreparedDocument,
  prose: string,
): HostPreparedDocument {
  return {
    ...prepared,
    document: {
      ...prepared.document,
      roots: [...prepared.document.roots],
      nodes: {
        ...prepared.document.nodes,
        intro: { id: "intro", type: "markdown", markdown: prose },
      },
    },
  };
}

function commit(
  store: ReviewHostStore,
  reviewId: string,
  expectedVersion: number,
  prepared: HostPreparedDocument,
  identity = commandIdentity({
    type: "document.mutate",
    reviewId,
    expectedVersion,
    document: prepared.document,
  }),
) {
  return store.command(identity, () => {
    const document = store.commitDocument(reviewId, expectedVersion, prepared);
    if (document.version !== expectedVersion)
      store.appendEvent(reviewId, "document.committed", {
        reviewId,
        version: document.version,
      });
    return document;
  });
}

describe("ReviewHostStore transactions and history", () => {
  it("persists host identity, review metadata, document evidence and command responses across restart", () => {
    const { store, databasePath, repositoryId, review, prepared } = fixture();
    const hostId = store.hostId;
    const workspaceId = store.workspaceId;
    const identity = commandIdentity({
      type: "document.mutate",
      reviewId: review.id,
    });
    const response = commit(
      store,
      review.id,
      0,
      edit(prepared, "Saved explanation"),
      identity,
    );
    const saved = store.document(review.id);
    closeStore(store);

    const restarted = openStore(databasePath);
    expect(restarted.hostId).toBe(hostId);
    expect(restarted.workspaceId).toBe(workspaceId);
    expect(restarted.review(review.id)).toMatchObject({
      id: review.id,
      documentVersion: 1,
    });
    expect(restarted.document(review.id)).toEqual(saved);
    expect(restarted.receipt(identity)).toEqual(response);
    expect(restarted.repositories()).toEqual([
      { id: repositoryId, displayName: "Review", vcs: "git" },
    ]);
    expect(
      restarted.documentHistory(review.id).map((version) => version.version),
    ).toEqual([1, 0]);
  });

  it("preserves old document versions while deduplicating unchanged content objects", () => {
    const { store, databasePath, review, prepared } = fixture();
    const original = store.document(review.id);
    const counts = persistenceCounts(databasePath);
    commit(store, review.id, 0, edit(prepared, "Revised explanation"));

    expect(store.document(review.id, 0)).toEqual(original);
    expect(store.document(review.id).nodes.intro).toEqual({
      id: "intro",
      type: "markdown",
      markdown: "Revised explanation",
    });
    expect(persistenceCounts(databasePath)?.objects).toBe(
      Number(counts?.objects) + 1,
    );
    expect(store.document(review.id).evidence).toEqual(original.evidence);
  });

  it("keeps authoring independent of other reviews and metadata versions", () => {
    const { store, repositoryId, review, prepared } = fixture();
    const other = newReview(repositoryId);
    const otherPrepared = preparedDocument(repositoryId, "Other review");
    store.command(commandIdentity(), () =>
      store.createReview(other, otherPrepared),
    );
    store.command(commandIdentity(), () =>
      store.updateReview(review.id, 0, (before) => ({
        ...before,
        version: 1,
        title: "Renamed",
      })),
    );
    commit(store, other.id, 0, edit(otherPrepared, "Other review changed"));
    commit(store, review.id, 0, edit(prepared, "This review changed"));

    expect(store.document(review.id).nodes.intro).toMatchObject({
      markdown: "This review changed",
    });
    expect(store.document(other.id).nodes.intro).toMatchObject({
      markdown: "Other review changed",
    });
    expect(store.review(review.id)).toMatchObject({
      title: "Renamed",
      version: 1,
      documentVersion: 1,
    });
    expect(store.review(other.id)).toMatchObject({
      version: 0,
      documentVersion: 1,
    });
  });

  it("rolls back content objects, manifests, retired IDs, events and receipt together", () => {
    const { store, databasePath, review, prepared } = fixture();
    const before = store.document(review.id);
    const counts = persistenceCounts(databasePath);
    const cursor = store.cursor();
    const identity = commandIdentity();
    const proposed = edit(prepared, "Must roll back");
    proposed.document.roots.push("temporary");
    proposed.document.nodes.temporary = { id: "temporary", type: "divider" };

    expect(() =>
      store.command(identity, () => {
        store.commitDocument(review.id, 0, proposed);
        store.appendEvent(review.id, "document.committed", {
          secret: "must not escape rollback",
        });
        throw new Error("simulated failure before commit");
      }),
    ).toThrow("simulated failure before commit");

    expect(store.document(review.id)).toEqual(before);
    expect(persistenceCounts(databasePath)).toEqual(counts);
    expect(store.cursor()).toBe(cursor);
    expect(store.receipt(identity)).toBeNull();
    expect(store.retiredIds(review.id).nodeIds.has("temporary")).toBe(false);
    expect(
      commit(store, review.id, 0, edit(prepared, "A later write succeeds"))
        .result,
    ).toMatchObject({ version: 1 });
  });

  it("rolls back earlier writes when a relationship rejects review creation", () => {
    const { store, databasePath, repositoryId } = fixture();
    const counts = persistenceCounts(databasePath);
    const identity = commandIdentity();
    const orphan = newReview(randomUUID());
    expect(() =>
      store.command(identity, () => {
        store.appendEvent(null, "attempted.create", { id: orphan.id });
        return store.createReview(
          orphan,
          preparedDocument(orphan.repositoryId),
        );
      }),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(persistenceCounts(databasePath)).toEqual(counts);
    expect(store.receipt(identity)).toBeNull();
    expect(store.repositories()[0]?.id).toBe(repositoryId);
  });

  it("rejects a stale writer using an independent SQLite connection", () => {
    const { store, databasePath, review, prepared } = fixture();
    const other = openStore(databasePath);
    const versionA = store.document(review.id).version;
    const versionB = other.document(review.id).version;
    commit(store, review.id, versionA, edit(prepared, "Writer A"));
    const counts = persistenceCounts(databasePath);
    const identity = commandIdentity();

    expect(() =>
      commit(other, review.id, versionB, edit(prepared, "Writer B"), identity),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(other.document(review.id).nodes.intro).toMatchObject({
      markdown: "Writer A",
    });
    expect(other.receipt(identity)).toBeNull();
    expect(persistenceCounts(databasePath)).toEqual(counts);
  });

  it("records successful no-ops without creating a version or changing the cursor", () => {
    const { store, databasePath, review, prepared } = fixture();
    const before = store.document(review.id);
    const counts = persistenceCounts(databasePath);
    const cursor = store.cursor();
    const identity = commandIdentity();
    expect(commit(store, review.id, 0, prepared, identity).result).toEqual(
      before,
    );
    expect(store.documentHistory(review.id)).toHaveLength(1);
    expect(store.cursor()).toBe(cursor);
    expect(persistenceCounts(databasePath)).toEqual({
      ...counts,
      receipts: Number(counts?.receipts) + 1,
    });
    expect(store.receipt(identity)?.result).toEqual(before);
  });

  it("remembers removed identities across restart separately for nodes and definitions", () => {
    const { store, databasePath, review, prepared } = fixture();
    const removed: HostPreparedDocument = {
      ...prepared,
      document: {
        schemaVersion: 1,
        roots: ["intro"],
        nodes: { intro: prepared.document.nodes.intro! },
        definitions: {},
      },
      evidence: {},
    };
    commit(store, review.id, 0, removed);
    expect(store.retiredIds(review.id)).toEqual({
      nodeIds: new Set(["database"]),
      definitionIds: new Set(["database"]),
    });
    closeStore(store);
    const reopened = openStore(databasePath);
    expect(reopened.retiredIds(review.id)).toEqual({
      nodeIds: new Set(["database"]),
      definitionIds: new Set(["database"]),
    });
    expect(reopened.document(review.id, 0).nodes.database).toMatchObject({
      type: "code_peek",
    });
  });
});

describe("ReviewHostStore idempotency", () => {
  it("returns the original response after later edits without invoking the retry callback", () => {
    const { store, databasePath, review, prepared } = fixture();
    const identity = commandIdentity({
      type: "document.mutate",
      expectedVersion: 0,
      reviewId: review.id,
    });
    const first = commit(
      store,
      review.id,
      0,
      edit(prepared, "First edit"),
      identity,
    );
    commit(store, review.id, 1, edit(prepared, "Second edit"));
    const counts = persistenceCounts(databasePath);
    const replay = store.command(identity, () => {
      throw new Error("a replay must not run the mutation again");
    });

    expect(replay).toEqual(first);
    expect(replay.result).toMatchObject({ version: 1 });
    expect(store.document(review.id)).toMatchObject({ version: 2 });
    expect(persistenceCounts(databasePath)).toEqual(counts);
  });

  it("rejects command-ID reuse with changed arguments, but scopes IDs by client", () => {
    const { store, review, prepared } = fixture();
    const identity = commandIdentity({
      type: "document.mutate",
      expectedVersion: 0,
    });
    commit(store, review.id, 0, edit(prepared, "First"), identity);
    expect(() =>
      store.receipt({
        ...identity,
        request: { type: "document.mutate", expectedVersion: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() =>
      store.command(
        { ...identity, request: { type: "other.command" } },
        () => null,
      ),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(store.receipt({ ...identity, clientId: randomUUID() })).toBeNull();
  });

  it("recovers a lost successful response after process restart", () => {
    const { store, databasePath, review, prepared } = fixture();
    const identity = commandIdentity({
      type: "document.mutate",
      expectedVersion: 0,
    });
    const committed = commit(
      store,
      review.id,
      0,
      edit(prepared, "Saved before disconnect"),
      identity,
    );
    closeStore(store);
    const restarted = openStore(databasePath);
    expect(
      restarted.command(identity, () => {
        throw new Error("stale expectedVersion must not be applied again");
      }),
    ).toEqual(committed);
    expect(restarted.documentHistory(review.id)).toHaveLength(2);
  });
});

describe("ReviewHostStore snapshot and event delivery", () => {
  it("pairs a consistent snapshot with a cursor despite another connection committing during the read", () => {
    const { store, databasePath, review, prepared } = fixture();
    const writer = openStore(databasePath);
    const before = store.document(review.id);
    const oldCursor = store.cursor();
    const snapshot = store.snapshot(() => {
      const observed = store.document(review.id);
      commit(writer, review.id, 0, edit(prepared, "Committed during snapshot"));
      return observed;
    });

    expect(snapshot).toEqual({ result: before, eventCursor: oldCursor });
    const replay = store.events(snapshot.eventCursor, {
      principalId: review.createdBy,
      reviewId: review.id,
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      reviewId: review.id,
      type: "document.committed",
      payload: { version: 1 },
    });
    expect(store.document(review.id).nodes.intro).toMatchObject({
      markdown: "Committed during snapshot",
    });
  });

  it("filters private and cross-review events while preserving committed event order", () => {
    const { store, repositoryId, review } = fixture();
    const otherReview = newReview(repositoryId);
    store.command(commandIdentity(), () =>
      store.createReview(otherReview, preparedDocument(repositoryId)),
    );
    const after = store.cursor();
    const otherPrincipal = randomUUID();
    store.command(commandIdentity(), () => {
      store.appendEvent(review.id, "thread.created", { text: "public" });
      store.appendEvent(
        review.id,
        "draft.saved",
        { text: "private draft" },
        review.createdBy,
      );
      store.appendEvent(otherReview.id, "thread.created", {
        text: "another review",
      });
      store.appendEvent(review.id, "thread.replied", { text: "public reply" });
      return null;
    });

    expect(
      store
        .events(after, { principalId: otherPrincipal, reviewId: review.id })
        .map((event) => event.payload),
    ).toEqual([{ text: "public" }, { text: "public reply" }]);
    expect(
      store
        .events(after, { principalId: review.createdBy, reviewId: review.id })
        .map((event) => event.type),
    ).toEqual(["thread.created", "draft.saved", "thread.replied"]);
    const firstPage = store.events(after, {
      principalId: otherPrincipal,
      reviewId: review.id,
      limit: 1,
    });
    expect(
      store.events(firstPage[0]!.cursor, {
        principalId: otherPrincipal,
        reviewId: review.id,
      }),
    ).toHaveLength(1);
  });

  it("rejects malformed, foreign-host and future cursors instead of silently missing events", () => {
    const { store, review } = fixture();
    for (const cursor of [
      "",
      "0",
      `v1:${randomUUID()}:0`,
      `v1:${store.hostId}:01`,
      `v1:${store.hostId}:99999`,
      `v1:${store.hostId}:9007199254740992`,
    ]) {
      expect(() =>
        store.events(cursor, { principalId: review.createdBy }),
      ).toThrow(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    }
  });
});

describe("ReviewHostStore lifecycle and integrity", () => {
  it.each(["closed", "trashed"])("does not author a %s review", (state) => {
    const { store, databasePath, review, prepared } = fixture();
    store.command(commandIdentity(), () =>
      store.updateReview(review.id, 0, (before) => ({
        ...before,
        version: before.version + 1,
        workflow: state === "closed" ? "closed" : before.workflow,
        deletedAt: state === "trashed" ? "2026-09-10T13:00:00Z" : null,
      })),
    );
    const counts = persistenceCounts(databasePath);
    expect(() =>
      commit(store, review.id, 0, edit(prepared, "Rejected")),
    ).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(store.document(review.id).nodes.intro).toMatchObject({
      markdown: "Initial explanation",
    });
    expect(store.reviews().some((item) => item.id === review.id)).toBe(
      state !== "trashed",
    );
    expect(store.reviews(true).some((item) => item.id === review.id)).toBe(
      true,
    );
    expect(persistenceCounts(databasePath)).toEqual(counts);
  });

  it("refuses metadata updates that redirect document/repository identity", () => {
    const { store, review } = fixture();
    expect(() =>
      store.command(commandIdentity(), () =>
        store.updateReview(review.id, 0, (before) => ({
          ...before,
          version: 1,
          documentId: randomUUID(),
        })),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(() =>
      store.command(commandIdentity(), () =>
        store.updateReview(review.id, 0, (before) => ({
          ...before,
          version: 1,
          documentVersion: 100,
        })),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(store.review(review.id)).toEqual(review);
  });

  it("refuses unsupported databases without changing their data or journal mode", () => {
    const databasePath = path.join(directory(), "future.db");
    changeDatabase(databasePath, (db) => {
      db.exec(
        "CREATE TABLE host_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; CREATE TABLE retained_notes(note TEXT NOT NULL) STRICT;",
      );
      db.prepare("INSERT INTO host_meta(key,value) VALUES (?,?)").run(
        "schema_version",
        "99",
      );
      db.prepare("INSERT INTO retained_notes(note) VALUES (?)").run(
        "Preserve newer application data",
      );
    });
    const journalMode = inspect(databasePath, (db) =>
      db.prepare("PRAGMA journal_mode").get(),
    );
    expect(() => openStore(databasePath)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT note FROM retained_notes").all(),
      ),
    ).toEqual([{ note: "Preserve newer application data" }]);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare("SELECT value FROM host_meta WHERE key='schema_version'")
          .get(),
      ),
    ).toEqual({ value: "99" });
    expect(
      inspect(databasePath, (db) => db.prepare("PRAGMA journal_mode").get()),
    ).toEqual(journalMode);
  });

  it("detects a changed content object rather than trusting its stored hash", () => {
    const { store, databasePath, review } = fixture();
    changeDatabase(databasePath, (db) => {
      db.prepare(
        "UPDATE host_content_objects SET value_json=? WHERE kind='node' AND json_extract(value_json,'$.id')='intro'",
      ).run(
        JSON.stringify({
          id: "intro",
          type: "markdown",
          markdown: "Tampered text",
        }),
      );
    });
    expect(() => store.document(review.id)).toThrow(
      expect.objectContaining({ code: "INTEGRITY_ERROR" }),
    );
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT json_extract(value_json,'$.markdown') AS markdown FROM host_content_objects WHERE kind='node' AND json_extract(value_json,'$.id')='intro'",
          )
          .get(),
      ),
    ).toEqual({ markdown: "Tampered text" });
  });

  it("detects a broken manifest hash even when its referenced content is valid", () => {
    const { store, databasePath, review } = fixture();
    changeDatabase(databasePath, (db) =>
      db
        .prepare(
          "UPDATE host_document_versions SET content_hash=? WHERE review_id=?",
        )
        .run("f".repeat(64), review.id),
    );
    expect(() => store.document(review.id)).toThrow(
      expect.objectContaining({ code: "INTEGRITY_ERROR" }),
    );
  });

  it("rejects writes outside command transactions before making any changes", () => {
    const { store, databasePath, review, prepared, repositoryId } = fixture();
    const counts = persistenceCounts(databasePath);
    const otherReview = newReview(repositoryId);
    for (const write of [
      () =>
        store.registerRepository({
          id: randomUUID(),
          displayName: "Other",
          vcs: "git",
          localPath: "/not-used",
        }),
      () => store.createReview(otherReview, preparedDocument(repositoryId)),
      () =>
        store.updateReview(review.id, 0, (before) => ({
          ...before,
          version: 1,
          title: "Not saved",
        })),
      () => store.commitDocument(review.id, 0, edit(prepared, "Not saved")),
      () => store.appendEvent(review.id, "not.saved", null),
    ]) {
      expect(write).toThrow("inside a command transaction");
    }
    expect(persistenceCounts(databasePath)).toEqual(counts);
  });
});
