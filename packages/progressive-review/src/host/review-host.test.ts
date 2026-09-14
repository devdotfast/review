import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  type HostCommandInputs,
  type HostCommandName,
  HostCommandSchema,
  type HostDocumentOperation,
  HostDocumentStateSchema,
  type HostPermission,
  type HostQueryInputs,
  type HostQueryName,
  HostQuerySchema,
  HostRepositorySchema,
  HostReviewCommitSchema,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalEvidenceProvider } from "./evidence-provider";
import { type HostAccess, ReviewHost, documentInput } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

const directories: string[] = [];
const stores = new Set<ReviewHostStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore(databasePath: string) {
  const store = new ReviewHostStore(databasePath);
  stores.add(store);
  return store;
}

function closeStore(store: ReviewHostStore) {
  store.close();
  stores.delete(store);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function access(
  kind: "human" | "agent",
  permissions: HostPermission[],
): HostAccess {
  return {
    principal: {
      id: randomUUID(),
      kind,
      displayName: kind === "human" ? "Reviewer" : "Author",
    },
    permissions: new Set(permissions),
  };
}

function git(repositoryPath: string, ...args: string[]) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(repositoryPath: string) {
  mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  const file = path.join(repositoryPath, "src/database.ts");
  writeFileSync(
    file,
    "export const shared = false;\nexport const reviews = 1;\n",
  );
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "Base");
  const base = git(repositoryPath, "rev-parse", "HEAD");
  writeFileSync(
    file,
    "export const shared = true;\nexport const reviews = 2;\n",
  );
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "Shared review database");
  return { base, head: git(repositoryPath, "rev-parse", "HEAD") };
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-host-service-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  const pins = initializeRepository(repositoryPath);
  const databasePath = path.join(directory, "review.db");
  const store = openStore(databasePath);
  const host = new ReviewHost(store);
  const human = access("human", [
    "read",
    "author",
    "human",
    "register_repository",
  ]);
  const author = access("agent", ["read", "author"]);
  const clientId = randomUUID();
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId,
  };
  const command = (
    type: HostCommandName,
    input: HostCommandInputs[HostCommandName] | JsonValue,
    commandId: string = randomUUID(),
  ) => HostCommandSchema.parse({ ...envelope, commandId, type, input });
  const query = (
    type: HostQueryName,
    input: HostQueryInputs[HostQueryName] | JsonValue = {},
  ) => HostQuerySchema.parse({ ...envelope, type, input });
  const registered = await host.command(
    human,
    command("repository.register", { path: repositoryPath }),
  );
  const repository = HostRepositorySchema.parse(registered.result);
  const create = async (title = "Shared review database") => {
    const request = command("review.create", {
      repositoryId: repository.id,
      change: { kind: "range", baseRef: pins.base, headRef: pins.head },
      title,
      description: "A portable review of the new database.",
    });
    const response = await host.command(author, request);
    return {
      request,
      response,
      ...HOST_COMMAND_DEFINITIONS["review.create"].result.parse(
        response.result,
      ),
    };
  };
  const created = await create();
  const mutation = (
    reviewVersion: number,
    operations: HostDocumentOperation[],
  ) =>
    command("document.mutate", {
      reviewId: created.review.id,
      expectedReviewVersion: reviewVersion,
      operations,
    });
  const mutate = async (
    reviewVersion: number,
    operations: HostDocumentOperation[],
  ) => {
    const response = await host.command(
      author,
      mutation(reviewVersion, operations),
    );
    return HostReviewCommitSchema.parse(response.result);
  };
  return {
    directory,
    repositoryPath,
    databasePath,
    store,
    host,
    human,
    author,
    clientId,
    repository,
    pins,
    created,
    create,
    command,
    query,
    mutation,
    mutate,
  };
}

function prose(
  id = "intro",
  markdown = "Shared database",
  afterId: string | null = null,
): HostDocumentOperation {
  return {
    op: "node.insert",
    node: { id, type: "markdown", markdown },
    placement: {
      parentId: null,
      position:
        afterId === null
          ? { kind: "start" }
          : { kind: "after", nodeId: afterId },
    },
  };
}

function anchor(id = "source", fromLine = 1): HostDocumentOperation[] {
  return [
    {
      op: "definition.put",
      id,
      value: {
        kind: "anchor",
        title: "Database",
        source: {
          side: "head",
          file: "src/database.ts",
          fromLine,
          toLine: fromLine,
        },
      },
    },
    {
      op: "node.insert",
      node: { id: `${id}_peek`, type: "code_peek", anchorId: id },
      placement: { parentId: null, position: { kind: "start" } },
    },
  ];
}

function counts(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare(`SELECT
      (SELECT count(*) FROM host_content_objects) AS objects,
      (SELECT count(*) FROM host_document_versions) AS versions,
      (SELECT count(*) FROM host_document_ids) AS ids,
      (SELECT count(*) FROM host_command_receipts) AS receipts,
      (SELECT count(*) FROM host_checkpoints) AS checkpoints,
      (SELECT count(*) FROM host_events) AS events`)
      .get();
  } finally {
    db.close();
  }
}

describe("ReviewHost authorization and portable records", () => {
  it("derives attribution from the authenticated principal and exposes no local repository path", async () => {
    const f = await fixture();
    expect(f.created.review.createdBy).toBe(f.author.principal.id);
    expect(f.created.review.createdBy).not.toBe(f.clientId);
    expect(f.created.snapshot.createdBy).toBe(f.author.principal.id);
    expect(f.created.document.binding).toMatchObject({
      repositoryId: f.repository.id,
      baseCommit: f.pins.base,
      headCommit: f.pins.head,
    });
    const repositories = await f.host.query(
      f.author,
      f.query("repositories.list"),
    );
    expect(JSON.stringify(repositories)).not.toContain(f.repositoryPath);
    const listed = HOST_QUERY_DEFINITIONS["repositories.list"].result.parse(
      repositories.result,
    );
    expect(listed.items).toEqual([f.repository]);
    expect(() =>
      f.command("review.create", {
        ...f.created.request.input,
        createdBy: f.human.principal.id,
      }),
    ).toThrow(/createdBy/);

    const changed = await f.mutate(0, [prose()]);
    expect(changed.snapshot.createdBy).toBe(f.author.principal.id);
  });

  it("advertises only available capabilities and operations granted to the caller", async () => {
    const f = await fixture();
    const readOnly = access("agent", ["read"]);
    const result = HOST_QUERY_DEFINITIONS.capabilities.result.parse(
      (await f.host.query(readOnly, f.query("capabilities"))).result,
    );
    expect(result.ask).toEqual({
      defaultHarness: null,
      supportedHarnesses: [],
      isolation: "trusted_local",
    });
    expect(result.commands).not.toContain("document.mutate");
    expect(result.commands).not.toContain("repository.register");
  });

  it("keeps Ask read-only and confines review queries, lists, and event streams to its grant", async () => {
    const f = await fixture();
    const other = await f.create("Other review");
    const ask = {
      ...access("agent", ["read"]),
      reviewIds: new Set([f.created.review.id]),
    };
    await expect(
      f.host.command(ask, f.mutation(0, [prose()])),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      f.host.query(ask, f.query("document.get", { reviewId: other.review.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = HOST_QUERY_DEFINITIONS["reviews.list"].result.parse(
      (await f.host.query(ask, f.query("reviews.list"))).result,
    );
    expect(listed.items.map((entry) => entry.review.id)).toEqual([
      f.created.review.id,
    ]);
    const filtered = HOST_QUERY_DEFINITIONS["reviews.list"].result.parse(
      (
        await f.host.query(
          ask,
          f.query("reviews.list", { repositoryId: f.repository.id }),
        )
      ).result,
    );
    expect(filtered.items.map((entry) => entry.review.id)).toEqual([
      f.created.review.id,
    ]);
    expect(() =>
      f.host.events(ask, f.store.workspaceId, f.created.response.eventCursor),
    ).toThrow(/granted review/);
    expect(() =>
      f.host.events(
        ask,
        f.store.workspaceId,
        f.created.response.eventCursor,
        other.review.id,
      ),
    ).toThrow(/not found/i);
    const before = f.store.cursor();
    await f.mutate(0, [prose()]);
    const events = f.host.events(
      ask,
      f.store.workspaceId,
      before,
      f.created.review.id,
    );
    expect(events.map((event) => event.reviewId)).toEqual([
      f.created.review.id,
    ]);
  });

  it("does not let a review-scoped credential create reviews or register repositories", async () => {
    const f = await fixture();
    const scoped = { ...f.human, reviewIds: new Set([f.created.review.id]) };
    await expect(
      f.host.command(scoped, f.created.request),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.host.command(
        scoped,
        f.command("repository.register", { path: f.repositoryPath }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires both the human permission and a human principal for workflow actions", async () => {
    const f = await fixture();
    const close = f.command("review.close", {
      reviewId: f.created.review.id,
      expectedStateVersion: 0,
    });
    await expect(f.host.command(f.author, close)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.host.command(
        { ...f.author, permissions: new Set<HostPermission>(["human"]) },
        close,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.host.command(
        { ...f.human, permissions: new Set<HostPermission>(["read"]) },
        close,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await f.host.command(f.human, close);
    await expect(
      f.host.command(f.author, f.mutation(0, [prose()])),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(f.store.review(f.created.review.id)).toMatchObject({
      state: "closed",
      stateVersion: 1,
      latestReviewVersion: 0,
    });
    await f.host.command(
      f.human,
      f.command("review.reopen", {
        reviewId: f.created.review.id,
        expectedStateVersion: 1,
      }),
    );
    expect((await f.mutate(0, [prose()])).reviewVersion).toBe(1);
    await f.host.command(
      f.human,
      f.command("review.trash", {
        reviewId: f.created.review.id,
        expectedStateVersion: 2,
      }),
    );
    await expect(
      f.host.command(f.author, f.mutation(1, [prose("blocked")])),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await f.host.command(
      f.human,
      f.command("review.untrash", {
        reviewId: f.created.review.id,
        expectedStateVersion: 3,
      }),
    );
    expect(f.store.review(f.created.review.id).deletedAt).toBeNull();
  });

  it("rejects host/workspace mismatches before either returning receipts or touching state", async () => {
    const f = await fixture();
    const baseline = counts(f.databasePath);
    for (const changes of [
      { hostId: randomUUID() },
      { workspaceId: randomUUID() },
    ]) {
      const command = HostCommandSchema.parse({
        ...f.created.request,
        ...changes,
      });
      await expect(f.host.command(f.author, command)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        f.host.query(
          f.author,
          HostQuerySchema.parse({
            ...f.query("review.get", { reviewId: f.created.review.id }),
            ...changes,
          }),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(counts(f.databasePath)).toEqual(baseline);
  });

  it("persists principal identity mappings privately across host restarts", async () => {
    const f = await fixture();
    const identityKey = "trusted-local:author-session";
    f.store.command(
      {
        clientId: "host",
        commandId: randomUUID(),
        request: { type: "principal.ensure" },
      },
      () => {
        f.store.putPrincipal(identityKey, f.author.principal);
        return null;
      },
    );
    closeStore(f.store);
    const restarted = openStore(f.databasePath);
    expect(restarted.principal(identityKey)).toEqual(f.author.principal);
    expect(restarted.principal("unknown")).toBeNull();
    expect(() => restarted.putPrincipal("another", f.human.principal)).toThrow(
      /transaction|command/i,
    );
    expect(() =>
      restarted.command(
        {
          clientId: "host",
          commandId: randomUUID(),
          request: { type: "principal.replace" },
        },
        () => {
          restarted.putPrincipal(identityKey, f.human.principal);
          return null;
        },
      ),
    ).toThrow(/UNIQUE constraint/);
    expect(restarted.principal(identityKey)).toEqual(f.author.principal);
  });
});

describe("ReviewHost document transactions", () => {
  it("replays the original response before CAS/source validation, including after restart and later edits", async () => {
    const f = await fixture();
    const request = f.mutation(0, anchor());
    const first = await f.host.command(f.author, request);
    await f.mutate(1, [prose()]);
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const baseline = counts(f.databasePath);
    expect(await f.host.command(f.author, request)).toEqual(first);
    expect(await f.host.command(f.author, f.created.request)).toEqual(
      f.created.response,
    );
    closeStore(f.store);
    const restarted = new ReviewHost(openStore(f.databasePath));
    expect(await restarted.command(f.author, request)).toEqual(first);
    expect(counts(f.databasePath)).toEqual(baseline);
    expect(restarted.store.document(f.created.review.id).reviewVersion).toBe(2);
  });

  it("detects payload reuse before source access and keeps command IDs principal/client scoped", async () => {
    const f = await fixture();
    const request = f.mutation(0, anchor());
    await f.host.command(f.author, request);
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const differentPayload = f.command(
      "document.mutate",
      {
        reviewId: f.created.review.id,
        expectedReviewVersion: 1,
        operations: [prose()],
      },
      request.commandId,
    );
    await expect(
      f.host.command(f.author, differentPayload),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const differentClient = HostCommandSchema.parse({
      ...differentPayload,
      clientId: randomUUID(),
    });
    expect(
      HostReviewCommitSchema.parse(
        (await f.host.command(f.author, differentClient)).result,
      ).reviewVersion,
    ).toBe(2);
    const differentPrincipal = access("agent", ["author"]);
    const newPrincipalCommand = f.command(
      "document.mutate",
      {
        reviewId: f.created.review.id,
        expectedReviewVersion: 2,
        operations: [prose("second")],
      },
      request.commandId,
    );
    expect(
      HostReviewCommitSchema.parse(
        (await f.host.command(differentPrincipal, newPrincipalCommand)).result,
      ).reviewVersion,
    ).toBe(3);
  });

  it("does not rebase a stale write when another connection commits between the version guard and canvas read", async () => {
    const f = await fixture();
    const other = openStore(f.databasePath);
    const reviewId = f.created.review.id;
    const original = f.store.document(reviewId);
    const snapshot = f.store.reviewSnapshot(reviewId);
    const readDocument = f.store.document.bind(f.store);
    const interleaved = vi
      .spyOn(f.store, "document")
      .mockImplementationOnce((id, version) => {
        other.command(
          { clientId: "other-writer", commandId: randomUUID(), request: {} },
          () =>
            other.commitDocument(
              reviewId,
              0,
              {
                document: documentInput(original),
                binding: original.binding,
                evidence: original.evidence,
              },
              {
                metadata: {
                  title: "Concurrent title",
                  description: snapshot.description,
                  labels: snapshot.labels,
                  mapVersions: snapshot.mapVersions,
                },
              },
            ),
        );
        return readDocument(id, version);
      });
    try {
      await expect(f.mutate(0, [prose()])).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
        currentVersion: 1,
      });
      expect(f.store.document(reviewId).nodes).toEqual({});
      expect(f.store.reviewSnapshot(reviewId).title).toBe("Concurrent title");
      expect(f.store.review(reviewId).latestReviewVersion).toBe(1);
    } finally {
      interleaved.mockRestore();
    }
  });

  it("rechecks CAS after asynchronous real-source validation across separate connections", async () => {
    const f = await fixture();
    const store2 = openStore(f.databasePath);
    const provider = new LocalEvidenceProvider((id) =>
      f.store.repositoryPath(id),
    );
    const entered = [gate(), gate()];
    const release = [gate(), gate()];
    const evidence = {
      async resolve(...args: Parameters<LocalEvidenceProvider["resolve"]>) {
        const quote = await provider.resolve(...args);
        const index = args[1].fromLine - 1;
        entered[index]!.resolve();
        await release[index]!.promise;
        return quote;
      },
    };
    const firstHost = new ReviewHost(f.store, { evidence });
    const secondHost = new ReviewHost(store2, { evidence });
    const first = firstHost.command(
      f.author,
      f.mutation(0, anchor("first", 1)),
    );
    const second = secondHost.command(
      f.author,
      f.mutation(0, anchor("second", 2)),
    );
    await Promise.all(entered.map((item) => item.promise));
    release[0]!.resolve();
    await first;
    const committedCounts = counts(f.databasePath);
    release[1]!.resolve();
    await expect(second).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(counts(f.databasePath)).toEqual(committedCounts);
    expect(f.store.document(f.created.review.id).roots).toEqual(["first_peek"]);
    expect(store2.document(f.created.review.id).evidence.first?.text).toBe(
      "export const shared = true;",
    );
    expect(
      f.store.retiredIds(f.created.review.id).nodeIds.has("second_peek"),
    ).toBe(false);
  });

  it("does not reserve IDs, receipts, or partial content when validation fails", async () => {
    const f = await fixture();
    const failed = f.mutation(0, [
      prose("intro", "<script>alert('x')</script>"),
    ]);
    const baseline = counts(f.databasePath);
    await expect(f.host.command(f.author, failed)).rejects.toMatchObject({
      name: "HostDocumentValidationError",
    });
    expect(counts(f.databasePath)).toEqual(baseline);
    const corrected = f.command(
      "document.mutate",
      {
        reviewId: f.created.review.id,
        expectedReviewVersion: 0,
        operations: [prose()],
      },
      failed.commandId,
    );
    expect(
      HostReviewCommitSchema.parse(
        (await f.host.command(f.author, corrected)).result,
      ).reviewVersion,
    ).toBe(1);
  });

  it.each(["document.mutate", "document.replace"] as const)(
    "rejects broken references in %s without saving any part of the candidate",
    async (type) => {
      const f = await fixture();
      await f.mutate(0, anchor());
      const reviewId = f.created.review.id;
      const before = f.store.document(reviewId);
      const baseline = counts(f.databasePath);
      const request = f.command(type, {
        reviewId,
        expectedReviewVersion: 1,
        ...(type === "document.mutate"
          ? {
              operations: [
                prose("intro", "New explanation", "source_peek"),
                { op: "definition.remove", id: "source" },
              ],
            }
          : {
              document: {
                ...documentInput(before),
                roots: [...before.roots, "intro"],
                nodes: {
                  ...before.nodes,
                  intro: {
                    id: "intro",
                    type: "markdown",
                    markdown: "New explanation",
                  },
                },
                definitions: {},
              },
            }),
      });
      await expect(f.host.command(f.author, request)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        diagnostics: [
          expect.objectContaining({
            path: "/candidate/document/nodes/source_peek/anchorId",
          }),
        ],
      });
      expect(f.store.document(reviewId)).toEqual(before);
      expect(counts(f.databasePath)).toEqual(baseline);
    },
  );

  it("guards metadata and canvas with one version and returns sparse re-applicable deltas", async () => {
    const f = await fixture();
    await f.mutate(0, [prose(), ...anchor()]);
    await f.host.command(
      f.author,
      f.command("review.update", {
        reviewId: f.created.review.id,
        expectedReviewVersion: 1,
        title: "New title",
        description: "New description",
        labels: ["storage"],
      }),
    );
    const before = f.store.document(f.created.review.id);
    await expect(
      f.mutate(1, [
        { op: "node.update", nodeId: "intro", changes: { markdown: "stale" } },
      ]),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const commit = await f.mutate(2, [
      {
        op: "node.update",
        nodeId: "intro",
        changes: { markdown: "Updated explanation" },
      },
    ]);
    const delta = commit.documentDelta!;
    expect(Object.keys(delta.changedNodes)).toEqual(["intro"]);
    expect(delta.changedDefinitions).toEqual({});
    expect(delta.changedEvidence).toEqual({});
    expect(commit).toMatchObject({
      previousReviewVersion: 2,
      reviewVersion: 3,
      snapshot: { title: "New title" },
    });
    expect({
      ...before,
      nodes: { ...before.nodes, ...delta.changedNodes },
      reviewVersion: commit.reviewVersion,
      contentHash: delta.contentHash,
      createdAt: delta.createdAt,
      roots: delta.roots,
      binding: delta.binding,
    }).toEqual(f.store.document(f.created.review.id));
    expect(f.store.review(f.created.review.id)).toMatchObject({
      stateVersion: 0,
      latestReviewVersion: 3,
    });
  });

  it("returns removals for definitions and retained evidence, while equivalent edits create no new version/event", async () => {
    const f = await fixture();
    await f.mutate(0, anchor());
    const beforeNoop = f.store.cursor();
    const noop = await f.mutate(1, [
      {
        op: "node.replace",
        node: { id: "source_peek", type: "code_peek", anchorId: "source" },
      },
    ]);
    expect(noop).toMatchObject({
      previousReviewVersion: 1,
      reviewVersion: 1,
      documentDelta: null,
    });
    expect(f.store.cursor()).toBe(beforeNoop);
    const removed = await f.mutate(1, [
      { op: "node.remove", nodeId: "source_peek", recursive: false },
      { op: "definition.remove", id: "source" },
    ]);
    expect(removed.documentDelta!.removedNodeIds).toEqual(["source_peek"]);
    expect(removed.documentDelta!.removedDefinitionIds).toEqual(["source"]);
    expect(removed.documentDelta!.removedEvidenceIds).toEqual(["source"]);
    const old = await f.host.query(
      f.author,
      f.query("document.evidence", {
        reviewId: f.created.review.id,
        reviewVersion: 1,
        anchorIds: ["source"],
      }),
    );
    expect(
      HOST_QUERY_DEFINITIONS["document.evidence"].result.parse(old.result)
        .evidence.source?.text,
    ).toBe("export const shared = true;");
    await expect(
      f.host.query(
        f.author,
        f.query("document.evidence", {
          reviewId: f.created.review.id,
          reviewVersion: 2,
          anchorIds: ["source"],
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("emits a bounded resync event for a large commit while retaining the full command result", async () => {
    const f = await fixture();
    const before = f.store.cursor();
    const commit = await f.mutate(0, [
      prose("first", "a".repeat(140_000)),
      prose("second", "b".repeat(140_000), "first"),
    ]);
    expect(Object.keys(commit.documentDelta!.changedNodes)).toEqual([
      "first",
      "second",
    ]);
    const events = f.host.events(
      f.author,
      f.store.workspaceId,
      before,
      f.created.review.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "review.resync_required",
      payload: { reviewId: f.created.review.id, reviewVersion: 1 },
    });
    expect(JSON.stringify(events[0]).length).toBeLessThan(1_024);
    const snapshot = HostDocumentStateSchema.parse(
      (
        await f.host.query(
          f.author,
          f.query("document.get", { reviewId: f.created.review.id }),
        )
      ).result,
    );
    expect(snapshot.nodes).toEqual(commit.documentDelta!.changedNodes);
  });

  it("keeps edits committed during asynchronous dry-run validation replayable from its captured cursor", async () => {
    const f = await fixture();
    const secondStore = openStore(f.databasePath);
    const writer = new ReviewHost(secondStore);
    const provider = new LocalEvidenceProvider((id) =>
      f.store.repositoryPath(id),
    );
    const entered = gate(),
      release = gate();
    const validating = new ReviewHost(f.store, {
      evidence: {
        async resolve(...args: Parameters<LocalEvidenceProvider["resolve"]>) {
          const quote = await provider.resolve(...args);
          entered.resolve();
          await release.promise;
          return quote;
        },
      },
    });
    const cursor = f.store.cursor();
    const pending = validating.query(
      f.author,
      f.query("document.validate", {
        reviewId: f.created.review.id,
        expectedReviewVersion: 0,
        operations: anchor(),
      }),
    );
    await entered.promise;
    await writer.command(
      f.author,
      f.command("review.update", {
        reviewId: f.created.review.id,
        expectedReviewVersion: 0,
        title: "Concurrent title",
      }),
    );
    release.resolve();
    const response = await pending;
    expect(response.result).toMatchObject({
      valid: true,
      basedOnReviewVersion: 0,
    });
    expect(response.eventCursor).toBe(cursor);
    expect(
      validating.events(
        f.author,
        f.store.workspaceId,
        response.eventCursor,
        f.created.review.id,
      ),
    ).toMatchObject([
      {
        type: "review.committed",
        payload: { previousReviewVersion: 0, reviewVersion: 1 },
      },
    ]);
    expect(f.store.document(f.created.review.id).nodes).toEqual({});
    await expect(
      validating.command(f.author, f.mutation(0, anchor())),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", currentVersion: 1 });
  });

  it("validates proposed edits without committing and reports errors against their exact source version", async () => {
    const f = await fixture();
    const baseline = counts(f.databasePath);
    const validate = (operations: HostDocumentOperation[]) =>
      f.host.query(
        f.author,
        f.query("document.validate", {
          reviewId: f.created.review.id,
          expectedReviewVersion: 0,
          operations,
        }),
      );
    const valid = HOST_QUERY_DEFINITIONS["document.validate"].result.parse(
      (await validate(anchor())).result,
    );
    expect(valid).toMatchObject({
      valid: true,
      basedOnReviewVersion: 0,
      diagnostics: [],
      affectedNodeIds: ["source_peek"],
    });
    const invalid = HOST_QUERY_DEFINITIONS["document.validate"].result.parse(
      (
        await validate([
          prose("invalid", "<iframe src='https://example.com'/>"),
        ])
      ).result,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.basedOnReviewVersion).toBe(0);
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
    const brokenReference = HOST_QUERY_DEFINITIONS[
      "document.validate"
    ].result.parse(
      (
        await validate(
          anchor().filter((operation) => operation.op === "node.insert"),
        )
      ).result,
    );
    expect(brokenReference).toMatchObject({
      valid: false,
      basedOnReviewVersion: 0,
      diagnostics: [
        expect.objectContaining({
          path: "/candidate/document/nodes/source_peek/anchorId",
        }),
      ],
    });
    expect(counts(f.databasePath)).toEqual(baseline);
  });
});

describe("ReviewHost immutable saved versions and queries", () => {
  it("restores removed content without rewinding resolved conversations, exact-version approvals or personal attention", async () => {
    const f = await fixture();
    const reviewId = f.created.review.id;
    await f.mutate(0, [prose()]);
    const created = HOST_COMMAND_DEFINITIONS["thread.create"].result.parse(
      (
        await f.host.command(
          f.human,
          f.command("thread.create", {
            reviewId,
            target: { kind: "node", reviewVersion: 1, nodeId: "intro" },
            body: "Please explain this section.",
          }),
        )
      ).result,
    );
    await f.host.command(
      f.author,
      f.command("thread.reply", {
        reviewId,
        threadId: created.thread.id,
        body: "The explanation is complete.",
      }),
    );
    await f.host.command(
      f.author,
      f.command("thread.set_status", {
        reviewId,
        threadId: created.thread.id,
        expectedThreadVersion: 0,
        status: "resolved",
      }),
    );
    await f.host.command(
      f.human,
      f.command("attention.update", {
        reviewId,
        expectedAttentionVersion: 0,
        lastViewedReviewVersion: 1,
        pinned: true,
      }),
    );
    const approval = HOST_COMMAND_DEFINITIONS["feedback.submit"].result.parse(
      (
        await f.host.command(
          f.human,
          f.command("feedback.submit", {
            reviewId,
            reviewVersion: 1,
            decision: "approve",
            drafts: [],
          }),
        )
      ).result,
    );
    const thread = f.store.thread(reviewId, created.thread.id);
    const messages = f.store.messages(reviewId, created.thread.id);
    const attention = f.store.attention(reviewId, f.human.principal.id);
    await f.mutate(1, [{ op: "node.remove", nodeId: "intro" }]);
    await f.host.command(
      f.author,
      f.command("review.version.restore", {
        reviewId,
        expectedReviewVersion: 2,
        fromReviewVersion: 1,
      }),
    );
    expect(f.store.thread(reviewId, created.thread.id)).toEqual(thread);
    expect(thread).toMatchObject({
      status: "resolved",
      target: { reviewVersion: 1 },
    });
    expect(f.store.messages(reviewId, created.thread.id)).toEqual(messages);
    expect(f.store.submission(reviewId, approval.id)).toEqual(approval);
    expect(approval).toMatchObject({ decision: "approve", reviewVersion: 1 });
    expect(f.store.attention(reviewId, f.human.principal.id)).toEqual(
      attention,
    );
    expect(f.store.review(reviewId)).toMatchObject({
      latestReviewVersion: 3,
      stateVersion: 0,
      state: "open",
    });
    const mapping = await f.host.query(
      f.human,
      f.query("thread.mapping", {
        reviewId,
        threadId: thread.id,
        reviewVersion: 3,
      }),
    );
    expect(mapping.result).toMatchObject({
      status: "exact",
      target: { kind: "node", nodeId: "intro", reviewVersion: 3 },
    });
  });

  it("restores metadata, canvas, code and selected maps while retaining historical versions", async () => {
    const f = await fixture(),
      reviewId = f.created.review.id;
    await f.mutate(0, [prose(), ...anchor()]);
    const map = HOST_COMMAND_DEFINITIONS["map.create"].result.parse(
      (
        await f.host.command(
          f.author,
          f.command("map.create", {
            reviewId,
            reviewVersion: 1,
            side: "head",
            map: {
              schemaVersion: 1,
              elements: {
                api: {
                  id: "api",
                  parentId: null,
                  label: "API",
                  kind: "component",
                  source: [],
                },
              },
              relationships: {},
            },
          }),
        )
      ).result,
    );
    expect(f.store.review(reviewId).latestReviewVersion).toBe(1);
    await f.host.command(
      f.author,
      f.command("review.update", {
        reviewId,
        expectedReviewVersion: 1,
        mapVersions: { head: map.id },
      }),
    );
    const historical = f.store.document(reviewId),
      initial = f.store.reviewSnapshot(reviewId);
    const newer = HOST_COMMAND_DEFINITIONS["map.mutate"].result.parse(
      (
        await f.host.command(
          f.author,
          f.command("map.mutate", {
            reviewId,
            mapId: map.mapId,
            expectedMapVersion: 0,
            operations: [
              {
                op: "element.put",
                element: {
                  id: "api",
                  parentId: null,
                  label: "New API",
                  kind: "component",
                  source: [],
                },
              },
            ],
          }),
        )
      ).result,
    );
    expect(f.store.reviewSnapshot(reviewId).mapVersions.head).toBe(map.id);
    await f.host.command(
      f.author,
      f.command("review.update", {
        reviewId,
        expectedReviewVersion: 2,
        title: "Revised title",
        labels: ["revised"],
        mapVersions: { head: newer.id },
      }),
    );
    await f.host.command(
      f.author,
      f.command("document.replace", {
        reviewId,
        expectedReviewVersion: 3,
        document: { schemaVersion: 1, roots: [], nodes: {}, definitions: {} },
      }),
    );
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const request = f.command("review.version.restore", {
      reviewId,
      expectedReviewVersion: 4,
      fromReviewVersion: 2,
    });
    const response = await f.host.command(f.author, request),
      restored = HostReviewCommitSchema.parse(response.result);
    expect(restored).toMatchObject({
      previousReviewVersion: 4,
      reviewVersion: 5,
      snapshot: {
        title: initial.title,
        labels: initial.labels,
        mapVersions: { head: map.id },
        restoredFromReviewVersion: 2,
      },
      documentDelta: { contentHash: historical.contentHash },
    });
    expect(documentInput(f.store.document(reviewId))).toEqual(
      documentInput(historical),
    );
    expect(f.store.document(reviewId, 2)).toEqual(historical);
    expect(f.store.reviewSnapshot(reviewId, 3)).toMatchObject({
      title: "Revised title",
      mapVersions: { head: newer.id },
    });
    expect(await f.host.command(f.author, request)).toEqual(response);
    const same = await f.host.command(
      f.author,
      f.command("review.version.restore", {
        reviewId,
        expectedReviewVersion: 5,
        fromReviewVersion: 2,
      }),
    );
    expect(HostReviewCommitSchema.parse(same.result)).toMatchObject({
      reviewVersion: 6,
      documentDelta: null,
    });
    closeStore(f.store);
    const restarted = openStore(f.databasePath);
    expect(restarted.document(reviewId, 2)).toEqual(historical);
    expect(restarted.reviewSnapshot(reviewId).restoredFromReviewVersion).toBe(
      2,
    );
  });

  it("starts new code with a blank canvas and rejects accidental same-code clearing", async () => {
    const f = await fixture(),
      reviewId = f.created.review.id;
    await f.mutate(0, [prose(), ...anchor()]);
    await expect(
      f.host.command(
        f.author,
        f.command("review.revision.create", {
          reviewId,
          expectedReviewVersion: 1,
          change: { kind: "range", baseRef: f.pins.base, headRef: f.pins.head },
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    writeFileSync(
      path.join(f.repositoryPath, "src/database.ts"),
      "export const shared = 3;\\n",
    );
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "New source revision");
    const head = git(f.repositoryPath, "rev-parse", "HEAD");
    const response = await f.host.command(
      f.author,
      f.command("review.revision.create", {
        reviewId,
        expectedReviewVersion: 1,
        change: { kind: "range", baseRef: f.pins.base, headRef: head },
      }),
    );
    expect(HostReviewCommitSchema.parse(response.result)).toMatchObject({
      reviewVersion: 2,
      snapshot: {
        title: f.created.snapshot.title,
        binding: { headCommit: head },
        mapVersions: { base: null, head: null },
      },
    });
    expect(f.store.document(reviewId)).toMatchObject({
      roots: [],
      nodes: {},
      definitions: {},
      evidence: {},
    });
    expect(f.store.document(reviewId, 1).nodes.intro).toBeDefined();
    await expect(f.mutate(2, [prose()])).rejects.toBeDefined();
    await f.mutate(2, [prose("fresh_intro")]);
    await f.host.command(
      f.author,
      f.command("review.version.restore", {
        reviewId,
        expectedReviewVersion: 3,
        fromReviewVersion: 1,
      }),
    );
    expect(f.store.document(reviewId).binding.headCommit).toBe(f.pins.head);
    expect(f.store.document(reviewId).nodes.intro).toBeDefined();
  });

  it("rejects retired IDs in replacements while permitting explicit historical restoration", async () => {
    const f = await fixture();
    await f.mutate(0, [prose()]);
    const old = documentInput(f.store.document(f.created.review.id));
    await f.mutate(1, [
      { op: "node.remove", nodeId: "intro", recursive: false },
    ]);
    await expect(
      f.host.command(
        f.author,
        f.command("document.replace", {
          reviewId: f.created.review.id,
          expectedReviewVersion: 2,
          document: old,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await f.host.command(
      f.author,
      f.command("review.version.restore", {
        reviewId: f.created.review.id,
        expectedReviewVersion: 2,
        fromReviewVersion: 1,
      }),
    );
    expect(documentInput(f.store.document(f.created.review.id))).toEqual(old);
  });

  it("rejects deleted sequence-step identities in mutations, replacements and dry-runs, but restores their original history", async () => {
    const f = await fixture();
    const reviewId = f.created.review.id;
    const message = {
      id: "step",
      fromActorId: "actor",
      toActorId: "actor",
      label: "Explain the operation",
      evidence: { kind: "explanation" as const },
      style: "call" as const,
    };
    await f.mutate(0, [
      {
        op: "definition.put",
        id: "actor",
        value: { kind: "actor", label: "Worker" },
      },
      {
        op: "node.insert",
        node: {
          id: "sequence",
          type: "sequence",
          title: "Flow",
          messages: [message],
        },
        placement: { parentId: null, position: { kind: "end" } },
      },
    ]);
    const historical = documentInput(f.store.document(reviewId));
    await f.mutate(1, [
      { op: "node.update", nodeId: "sequence", changes: { messages: [] } },
    ]);
    const operations: HostDocumentOperation[] = [
      {
        op: "node.update",
        nodeId: "sequence",
        changes: { messages: [message] },
      },
    ];
    const validation = await f.host.query(
      f.author,
      f.query("document.validate", {
        reviewId,
        expectedReviewVersion: 2,
        operations,
      }),
    );
    expect(validation.result).toMatchObject({
      valid: false,
      basedOnReviewVersion: 2,
      diagnostics: [
        {
          code: "RETIRED_ID",
          nodeId: "sequence",
          path: "/candidate/document/nodes/sequence/messages/0/id",
        },
      ],
    });
    await expect(f.mutate(2, operations)).rejects.toMatchObject({
      diagnostics: [{ code: "RETIRED_ID" }],
    });
    await expect(
      f.host.command(
        f.author,
        f.command("document.replace", {
          reviewId,
          expectedReviewVersion: 2,
          document: historical,
        }),
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: "RETIRED_ID" }] });
    expect(f.store.review(reviewId).latestReviewVersion).toBe(2);
    await f.mutate(2, [
      {
        op: "node.update",
        nodeId: "sequence",
        changes: { messages: [{ ...message, id: "fresh_step" }] },
      },
    ]);
    await f.host.command(
      f.author,
      f.command("review.version.restore", {
        reviewId,
        expectedReviewVersion: 3,
        fromReviewVersion: 1,
      }),
    );
    expect(documentInput(f.store.document(reviewId))).toEqual(historical);
    await f.mutate(4, [
      {
        op: "node.update",
        nodeId: "sequence",
        changes: { messages: [{ ...message, label: "Edited original step" }] },
      },
    ]);
    expect(f.store.review(reviewId).latestReviewVersion).toBe(5);
  });

  it("orders review listings by creation time and excludes later inserts from review and repository traversals", async () => {
    const f = await fixture();
    const latest = await f.create("Newest review");
    const readReviews = async (cursor?: string) =>
      HOST_QUERY_DEFINITIONS["reviews.list"].result.parse(
        (
          await f.host.query(
            f.human,
            f.query("reviews.list", { limit: 1, cursor }),
          )
        ).result,
      );
    const first = await readReviews();
    expect(first.items[0]!.review.id).toBe(latest.review.id);
    const old = {
      ...f.created.review,
      id: randomUUID(),
      createdAt: "2000-01-01T00:00:00Z",
    };
    const document = f.store.document(f.created.review.id);
    f.store.command(
      { clientId: "late-insert", commandId: randomUUID(), request: {} },
      () =>
        f.store.createReview(
          old,
          {
            document: documentInput(document),
            binding: document.binding,
            evidence: document.evidence,
          },
          {
            title: "Later insert with earlier clock",
            description: "",
            labels: [],
            mapVersions: { base: null, head: null },
          },
        ),
    );
    const second = await readReviews(first.nextCursor!);
    expect(second.items.map((item) => item.review.id)).toEqual([
      f.created.review.id,
    ]);
    expect(second.nextCursor).toBeNull();
    const register = (id: string) =>
      f.store.command(
        { clientId: "late-insert", commandId: randomUUID(), request: {} },
        () => {
          f.store.registerRepository({
            id,
            localPath: path.join(f.directory, id),
            displayName: id,
            vcs: "git",
          });
          return null;
        },
      );
    register("00000000-0000-4000-8000-000000000001");
    const readRepositories = async (cursor?: string) =>
      HOST_QUERY_DEFINITIONS["repositories.list"].result.parse(
        (
          await f.host.query(
            f.human,
            f.query("repositories.list", { limit: 1, cursor }),
          )
        ).result,
      );
    const repositories = await readRepositories();
    register("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const remaining = await readRepositories(repositories.nextCursor!);
    expect(remaining.items.map((item) => item.id)).toEqual([f.repository.id]);
    expect(remaining.nextCursor).toBeNull();
  });

  it("pages immutable review history and rejects a cursor for another review", async () => {
    const f = await fixture();
    await f.mutate(0, [prose()]);
    await f.mutate(1, [prose("second")]);
    const readHistory = async (input: JsonValue) =>
      HOST_QUERY_DEFINITIONS["review.history"].result.parse(
        (await f.host.query(f.author, f.query("review.history", input))).result,
      );
    const first = await readHistory({
      reviewId: f.created.review.id,
      limit: 1,
    });
    expect(first.items.map((item) => item.reviewVersion)).toEqual([2]);
    await f.mutate(2, [prose("third")]);
    const next = await readHistory({
      reviewId: f.created.review.id,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next.items.map((item) => item.reviewVersion)).toEqual([1, 0]);
    const other = await f.create("Other");
    await expect(
      readHistory({ reviewId: other.review.id, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("returns a document snapshot cursor that lets clients catch up and filters private events", async () => {
    const f = await fixture();
    const snapshot = await f.host.query(
      f.author,
      f.query("document.get", { reviewId: f.created.review.id }),
    );
    const first = HostDocumentStateSchema.parse(snapshot.result);
    expect(first.reviewVersion).toBe(0);
    await f.mutate(0, [prose()]);
    const append = (payload: JsonValue, principalId: string) =>
      f.store.command(
        { clientId: "host", commandId: randomUUID(), request: payload },
        () =>
          f.store.appendEvent(
            f.created.review.id,
            "private.feedback",
            payload,
            principalId,
          ),
      );
    append({ text: "Author's private draft" }, f.author.principal.id);
    append({ text: "Human's private draft" }, f.human.principal.id);
    const events = f.host.events(
      f.author,
      f.store.workspaceId,
      snapshot.eventCursor,
      f.created.review.id,
    );
    expect(events.map((event) => event.type)).toEqual([
      "review.committed",
      "private.feedback",
    ]);
    expect(events[0]?.payload).toMatchObject({
      previousReviewVersion: first.reviewVersion,
      reviewVersion: 1,
    });
    expect(events[1]?.payload).toEqual({ text: "Author's private draft" });
    const current = await f.host.query(
      f.author,
      f.query("document.get", { reviewId: f.created.review.id }),
    );
    expect(HostDocumentStateSchema.parse(current.result).reviewVersion).toBe(1);
    expect(
      f.host.events(
        f.author,
        f.store.workspaceId,
        current.eventCursor,
        f.created.review.id,
      ),
    ).toEqual([]);
  });
});
