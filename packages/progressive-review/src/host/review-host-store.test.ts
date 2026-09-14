import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type HostReviewState,
  type HostSourceRange,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  type HostCommandIdentity,
  type HostPreparedDocument,
  type HostPreparedMap,
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

const metadata = {
  title: "Local review",
  description: "",
  labels: [],
  mapVersions: { base: null, head: null },
};
function newReview(repositoryId: string): HostReviewState {
  return {
    id: randomUUID(),
    repositoryId,
    latestReviewVersion: 0,
    stateVersion: 0,
    state: "open",
    createdBy: randomUUID(),
    createdAt: "2026-09-10T12:00:00Z",
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
      const document = store.createReview(review, prepared, metadata);
      store.appendEvent(review.id, "review.created", {
        reviewId: review.id,
        reviewVersion: document.reviewVersion,
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
    if (document.reviewVersion !== expectedVersion)
      store.appendEvent(reviewId, "review.committed", {
        reviewId,
        reviewVersion: document.reviewVersion,
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
      latestReviewVersion: 1,
    });
    expect(restarted.document(review.id)).toEqual(saved);
    expect(restarted.receipt(identity)).toEqual(response);
    expect(restarted.repositories()).toEqual([
      { id: repositoryId, displayName: "Review", vcs: "git" },
    ]);
    expect(
      restarted
        .reviewHistory(review.id)
        .map((version) => version.reviewVersion),
    ).toEqual([1, 0]);
  });

  it("retains typed diagram item identities across restart and rebuilds them from historical versions", () => {
    const { store, databasePath, review, prepared } = fixture();
    const message = {
      id: "step",
      fromActorId: "actor",
      toActorId: "actor",
      label: "Work",
      evidence: { kind: "explanation" as const },
      style: "call" as const,
    };
    const frame = { id: "frame", anchorId: "database" };
    const operation = {
      id: "operation",
      kind: "read" as const,
      store: { storeId: "storage", collectionId: "reviews" },
      actorId: "actor",
      label: "Read",
      anchorId: "database",
    };
    const sequence = {
      id: "sequence",
      type: "sequence" as const,
      title: "Flow",
      messages: [message],
    };
    const stacks = {
      id: "stacks",
      type: "call_stack_diff" as const,
      title: "Stack",
      base: [frame],
      head: [frame],
    };
    const database = {
      id: "lens",
      type: "database_lens" as const,
      title: "Database",
      storeIds: ["storage"],
      useCases: [
        { id: "first", label: "First", operations: [operation] },
        { id: "second", label: "Second", operations: [operation] },
      ],
    };
    const saved: HostPreparedDocument = {
      ...prepared,
      document: {
        ...prepared.document,
        roots: [...prepared.document.roots, "sequence", "stacks", "lens"],
        nodes: { ...prepared.document.nodes, sequence, stacks, lens: database },
        definitions: {
          ...prepared.document.definitions,
          actor: { kind: "actor", label: "Worker" },
          storage: {
            kind: "store",
            label: "Storage",
            storage: "relational",
            collections: { reviews: { label: "Reviews", fields: {} } },
          },
        },
      },
    };
    commit(store, review.id, 0, saved);
    const removed: HostPreparedDocument = {
      ...saved,
      document: {
        ...saved.document,
        nodes: {
          ...saved.document.nodes,
          sequence: { ...sequence, messages: [] },
          stacks: { ...stacks, base: [] },
          lens: {
            ...database,
            useCases: [
              { ...database.useCases[0]!, operations: [] },
              database.useCases[1]!,
            ],
          },
        },
      },
    };
    commit(store, review.id, 1, removed);
    closeStore(store);
    // Simulate opening a retained database from before the item-index addition.
    changeDatabase(databasePath, (db) =>
      db.exec(
        "DELETE FROM host_document_item_ids; DELETE FROM host_meta WHERE key='diagram_item_ids_indexed'",
      ),
    );
    const restarted = openStore(databasePath);
    expect(
      restarted
        .reusedDocumentItems(review.id, saved.document)
        .map((item) => item.path)
        .sort(),
    ).toEqual([
      "/nodes/lens/useCases/0/operations/0/id",
      "/nodes/sequence/messages/0/id",
      "/nodes/stacks/base/0/id",
    ]);
    expect(() => commit(restarted, review.id, 2, saved)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
    // The same local names in a different diagram, frame side or use case are independent.
    const independent: HostPreparedDocument = {
      ...removed,
      document: {
        ...removed.document,
        roots: [...removed.document.roots, "other_sequence"],
        nodes: {
          ...removed.document.nodes,
          other_sequence: { ...sequence, id: "other_sequence" },
          lens: {
            ...database,
            useCases: [
              { ...database.useCases[0]!, operations: [] },
              database.useCases[1]!,
              { id: "third", label: "Third", operations: [operation] },
            ],
          },
        },
      },
    };
    commit(restarted, review.id, 2, independent);
    const noFirst: HostPreparedDocument = {
      ...independent,
      document: {
        ...independent.document,
        nodes: {
          ...independent.document.nodes,
          lens: { ...database, useCases: [database.useCases[1]!] },
        },
      },
    };
    commit(restarted, review.id, 3, noFirst);
    expect(
      restarted
        .reusedDocumentItems(review.id, independent.document)
        .map((item) => item.path),
    ).toContain("/nodes/lens/useCases/0/id");
    expect(() => commit(restarted, review.id, 4, independent)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
  });

  it("keeps removed map IDs retired within their lineage without changing review versions", () => {
    const { store, databasePath, review, repositoryId } = fixture();
    const app = {
      id: "app",
      parentId: null,
      kind: "component" as const,
      label: "App",
      description: "",
      source: [],
    };
    const target = { ...app, id: "target", label: "Target" };
    const link = {
      id: "link",
      kind: "semantic" as const,
      fromId: "app",
      toId: "target",
      label: "Uses",
      explanation: "Conceptual connection",
    };
    const original: HostPreparedMap = {
      repositoryId,
      commit: "2".repeat(40),
      evidence: {},
      map: {
        schemaVersion: 1,
        elements: { app, target },
        relationships: { link },
      },
    };
    const created = store.command(commandIdentity(), () =>
      store.createMap(review.id, original),
    );
    const first = store.maps(review.id, {}).items[0]!;
    const remaining: HostPreparedMap = {
      ...original,
      map: { ...original.map, elements: { app }, relationships: {} },
    };
    store.command(commandIdentity(), () =>
      store.commitMap(review.id, first.mapId, 0, remaining),
    );
    closeStore(store);
    changeDatabase(databasePath, (db) =>
      db.exec(
        "DELETE FROM host_map_item_ids; DELETE FROM host_meta WHERE key='map_item_ids_indexed'",
      ),
    );
    const restarted = openStore(databasePath);
    const restoreElement: HostPreparedMap = {
      ...remaining,
      map: { ...remaining.map, elements: { app, target } },
    };
    const restoreRelationship: HostPreparedMap = {
      ...remaining,
      map: {
        ...remaining.map,
        relationships: { link: { ...link, toId: "app" } },
      },
    };
    expect(() =>
      restarted.command(commandIdentity(), () =>
        restarted.commitMap(review.id, first.mapId, 1, restoreElement),
      ),
    ).toThrow(/Removed map element ID target/);
    expect(() =>
      restarted.command(commandIdentity(), () =>
        restarted.commitMap(review.id, first.mapId, 1, restoreRelationship),
      ),
    ).toThrow(/Removed map relationship ID link/);
    const freshIds: HostPreparedMap = {
      ...remaining,
      map: {
        ...remaining.map,
        elements: { app, replacement: { ...target, id: "replacement" } },
        relationships: { app: { ...link, id: "app", toId: "replacement" } },
      },
    };
    restarted.command(commandIdentity(), () =>
      restarted.commitMap(review.id, first.mapId, 1, freshIds),
    );
    const independent = restarted.command(commandIdentity(), () =>
      restarted.createMap(review.id, original),
    );
    expect(independent.result).not.toEqual(created.result);
    expect(restarted.mapVersion(review.id, first.id).elements.target).toEqual(
      target,
    );
    expect(restarted.currentMap(review.id, first.mapId).mapVersion).toBe(2);
    expect(restarted.review(review.id).latestReviewVersion).toBe(0);
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

  it("isolates reviews while metadata changes conflict with stale document edits", () => {
    const { store, repositoryId, review, prepared } = fixture();
    const other = newReview(repositoryId),
      otherPrepared = preparedDocument(repositoryId, "Other review");
    store.command(commandIdentity(), () =>
      store.createReview(other, otherPrepared, metadata),
    );
    store.command(commandIdentity(), () =>
      store.commitDocument(review.id, 0, prepared, {
        metadata: { ...metadata, title: "Renamed" },
        reason: "metadata",
      }),
    );
    commit(store, other.id, 0, edit(otherPrepared, "Other review changed"));
    expect(() =>
      commit(store, review.id, 0, edit(prepared, "Stale write")),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    commit(store, review.id, 1, edit(prepared, "This review changed"));
    expect(store.reviewSnapshot(review.id)).toMatchObject({
      title: "Renamed",
      reviewVersion: 2,
    });
    expect(store.review(other.id)).toMatchObject({
      stateVersion: 0,
      latestReviewVersion: 1,
    });
    expect(store.document(review.id).nodes.intro).toMatchObject({
      markdown: "This review changed",
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
        store.appendEvent(review.id, "review.committed", {
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
    ).toMatchObject({ reviewVersion: 1 });
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
          metadata,
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
    const versionA = store.document(review.id).reviewVersion;
    const versionB = other.document(review.id).reviewVersion;
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
    expect(store.reviewHistory(review.id)).toHaveLength(1);
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
    expect(replay.result).toMatchObject({ reviewVersion: 1 });
    expect(store.document(review.id)).toMatchObject({ reviewVersion: 2 });
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
    expect(restarted.reviewHistory(review.id)).toHaveLength(2);
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
      type: "review.committed",
      payload: { reviewVersion: 1 },
    });
    expect(store.document(review.id).nodes.intro).toMatchObject({
      markdown: "Committed during snapshot",
    });
  });

  it("filters private and cross-review events while preserving committed event order", () => {
    const { store, repositoryId, review } = fixture();
    const otherReview = newReview(repositoryId);
    store.command(commandIdentity(), () =>
      store.createReview(otherReview, preparedDocument(repositoryId), metadata),
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
  it("upgrades distinct checkpoint decisions without erasing original records or conversations", () => {
    const { store, databasePath, review, prepared } = fixture();
    closeStore(store);
    const checkpointId = randomUUID(),
      submissionId = randomUUID(),
      threadId = randomUUID();
    const legacy = {
      ...review,
      version: 0,
      title: "Current title",
      description: "Current description",
      labels: ["current"],
      workflow: "in_review",
      documentId: randomUUID(),
      documentVersion: 0,
      publishedCheckpointId: checkpointId,
      authorSessionId: null,
      updatedAt: review.createdAt,
    };
    const checkpoint = {
      id: checkpointId,
      reviewId: review.id,
      ordinal: 1,
      documentVersion: 0,
      bindingId: prepared.binding.id,
      title: "Approved title",
      description: "Approved description",
      mapVersions: { base: null, head: null },
      authorSessionId: null,
      createdBy: review.createdBy,
      createdAt: review.createdAt,
    };
    changeDatabase(databasePath, (db) => {
      db.exec(
        "DELETE FROM host_review_versions; DELETE FROM host_review_states;",
      );
      db.prepare(
        "UPDATE host_meta SET value='1' WHERE key='schema_version'",
      ).run();
      db.prepare("UPDATE host_reviews SET record_json=? WHERE id=?").run(
        JSON.stringify(legacy),
        review.id,
      );
      db.prepare("INSERT INTO host_checkpoints VALUES (?,?,?,?,?)").run(
        checkpointId,
        review.id,
        1,
        0,
        JSON.stringify(checkpoint),
      );
      db.prepare("INSERT INTO host_feedback_submissions VALUES (?,?,?,?)").run(
        submissionId,
        review.id,
        checkpointId,
        JSON.stringify({
          id: submissionId,
          reviewId: review.id,
          checkpointId,
          decision: "approve",
          createdBy: review.createdBy,
          createdAt: review.createdAt,
          messageIds: [],
          threadIds: [],
        }),
      );
      db.prepare("INSERT INTO host_threads VALUES (?,?,?,?)").run(
        threadId,
        review.id,
        0,
        JSON.stringify({
          id: threadId,
          reviewId: review.id,
          version: 1,
          target: { kind: "node", documentVersion: 0, nodeId: "intro" },
          evidence: null,
          status: "resolved",
          createdBy: review.createdBy,
          createdAt: review.createdAt,
          updatedAt: review.createdAt,
        }),
      );
    });
    const upgraded = openStore(databasePath);
    const decision = upgraded.submission(review.id, submissionId);
    expect(
      upgraded.reviewSnapshot(review.id, decision.reviewVersion),
    ).toMatchObject({
      title: "Approved title",
      description: "Approved description",
    });
    expect(upgraded.reviewSnapshot(review.id)).toMatchObject({
      title: "Current title",
      labels: ["current"],
    });
    expect(upgraded.thread(review.id, threadId)).toMatchObject({
      status: "resolved",
      threadVersion: 1,
      target: { kind: "node", reviewVersion: 0, nodeId: "intro" },
    });
    expect(upgraded.document(review.id, 0).nodes).toEqual(
      prepared.document.nodes,
    );
    expect(
      inspect(
        databasePath,
        (db) =>
          db
            .prepare("SELECT record_json FROM host_checkpoints WHERE id=?")
            .get(checkpointId)?.record_json,
      ),
    ).toBe(JSON.stringify(checkpoint));
    expect(
      inspect(
        databasePath,
        (db) =>
          db
            .prepare(
              "SELECT record_json FROM host_legacy_records WHERE table_name='host_reviews' AND record_id=?",
            )
            .get(review.id)?.record_json,
      ),
    ).toBe(JSON.stringify(legacy));
    closeStore(upgraded);
    expect(openStore(databasePath).submission(review.id, submissionId)).toEqual(
      decision,
    );
  });

  it("uses non-reused listing sequences when the newest private draft is deleted", () => {
    const { store, review } = fixture(),
      principalId = randomUUID();
    const draft = (id: string) => ({
      id,
      reviewId: review.id,
      principalId,
      draftVersion: 0,
      target: { kind: "document" as const, reviewVersion: 0 },
      evidence: null,
      body: "Saved feedback",
      createdAt: review.createdAt,
      updatedAt: review.createdAt,
    });
    const first = randomUUID(),
      second = randomUUID();
    store.command(commandIdentity(), () => store.saveDraft(draft(first), null));
    const boundary = store.feedbackSequence("drafts", review.id, principalId);
    store.command(commandIdentity(), () => {
      store.deleteDraft(review.id, first, principalId, 0);
      return null;
    });
    store.command(commandIdentity(), () =>
      store.saveDraft(draft(second), null),
    );
    expect(store.drafts(review.id, principalId, boundary)).toEqual([]);
    expect(
      store.feedbackSequence("drafts", review.id, principalId),
    ).toBeGreaterThan(boundary);
  });

  it.each(["closed", "trashed"])("does not author a %s review", (state) => {
    const { store, databasePath, review, prepared } = fixture();
    store.command(commandIdentity(), () =>
      store.updateReviewState(review.id, 0, (before) => ({
        ...before,
        stateVersion: before.stateVersion + 1,
        state: state === "closed" ? "closed" : before.state,
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

  it("refuses lifecycle updates that redirect material or repository identity", () => {
    const { store, review } = fixture();
    for (const changed of [
      { repositoryId: randomUUID() },
      { latestReviewVersion: 100 },
    ])
      expect(() =>
        store.command(commandIdentity(), () =>
          store.updateReviewState(review.id, 0, (before) => ({
            ...before,
            ...changed,
          })),
        ),
      ).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(store.review(review.id)).toEqual(review);
  });

  it("refuses an older or unrelated database without adding host tables or touching its bytes", () => {
    const databasePath = path.join(directory(), "review.db");
    changeDatabase(databasePath, (db) => {
      db.exec(
        "CREATE TABLE legacy_comments (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT",
      );
      db.prepare("INSERT INTO legacy_comments VALUES (?,?)").run(
        "kept",
        "Keep this older review intact.",
      );
    });
    const before = readFileSync(databasePath);
    const mode = statSync(databasePath).mode;
    expect(() => openStore(databasePath)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" }),
    );
    expect(readFileSync(databasePath)).toEqual(before);
    expect(statSync(databasePath).mode).toBe(mode);
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT body FROM legacy_comments WHERE id='kept'").get(),
      ),
    ).toEqual({ body: "Keep this older review intact." });
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
      () =>
        store.createReview(
          otherReview,
          preparedDocument(repositoryId),
          metadata,
        ),
      () =>
        store.updateReviewState(review.id, 0, (before) => ({
          ...before,
          state: "closed",
        })),
      () => store.commitDocument(review.id, 0, edit(prepared, "Not saved")),
      () => store.appendEvent(review.id, "not.saved", null),
    ]) {
      expect(write).toThrow("inside a command transaction");
    }
    expect(persistenceCounts(databasePath)).toEqual(counts);
  });
});
