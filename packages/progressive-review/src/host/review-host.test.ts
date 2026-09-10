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
  type HostCommandName,
  HostCommandSchema,
  HostDocumentCommitSchema,
  type HostDocumentOperation,
  HostDocumentStateSchema,
  type HostPermission,
  type HostQueryName,
  HostQuerySchema,
  HostRepositorySchema,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

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
    "publish",
    "human",
    "register_repository",
  ]);
  const author = access("agent", ["read", "author", "publish"]);
  const clientId = randomUUID();
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId,
  };
  const command = (
    type: HostCommandName,
    input: JsonValue,
    commandId: string = randomUUID(),
  ) => HostCommandSchema.parse({ ...envelope, commandId, type, input });
  const query = (type: HostQueryName, input: JsonValue = {}) =>
    HostQuerySchema.parse({ ...envelope, type, input });
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
  const mutation = (version: number, operations: HostDocumentOperation[]) =>
    command("document.mutate", {
      reviewId: created.review.id,
      expectedDocumentVersion: version,
      operations,
    });
  const mutate = async (
    version: number,
    operations: HostDocumentOperation[],
  ) => {
    const response = await host.command(author, mutation(version, operations));
    return HostDocumentCommitSchema.parse(response.result);
  };
  const publish = (documentVersion: number, reviewVersion: number) =>
    command("review.publish", {
      reviewId: created.review.id,
      expectedDocumentVersion: documentVersion,
      expectedReviewVersion: reviewVersion,
      mapVersions: { base: null, head: null },
    });
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
    publish,
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
    placement: { parentId: null, afterId },
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
      placement: { parentId: null, afterId: null },
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
    expect(f.created.review.authorSessionId).toBeNull();
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

    const checkpoint = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (await f.host.command(f.author, f.publish(0, 0))).result,
    );
    expect(checkpoint.createdBy).toBe(f.author.principal.id);
  });

  it("advertises only available capabilities and operations granted to the caller", async () => {
    const f = await fixture();
    const readOnly = access("agent", ["read"]);
    const result = HOST_QUERY_DEFINITIONS.capabilities.result.parse(
      (await f.host.query(readOnly, f.query("capabilities"))).result,
    );
    expect(result.source).toEqual({ read: true, navigation: false });
    expect(result.ask).toEqual({
      available: false,
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
    await expect(f.host.command(ask, f.publish(0, 0))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.host.query(ask, f.query("document.get", { reviewId: other.review.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = HOST_QUERY_DEFINITIONS["reviews.list"].result.parse(
      (await f.host.query(ask, f.query("reviews.list"))).result,
    );
    expect(listed.items.map((review) => review.id)).toEqual([
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
    expect(filtered.items.map((review) => review.id)).toEqual([
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
      expectedVersion: 0,
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
    await expect(
      f.host.command(f.author, f.publish(0, 1)),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await f.host.command(
      f.human,
      f.command("review.reopen", {
        reviewId: f.created.review.id,
        expectedVersion: 1,
      }),
    );
    expect((await f.mutate(0, [prose()])).version).toBe(1);
    await f.host.command(
      f.human,
      f.command("review.trash", {
        reviewId: f.created.review.id,
        expectedVersion: 2,
      }),
    );
    await expect(
      f.host.command(f.author, f.publish(1, 3)),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await f.host.command(
      f.human,
      f.command("review.restore", {
        reviewId: f.created.review.id,
        expectedVersion: 3,
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
    expect(restarted.store.document(f.created.review.id).version).toBe(2);
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
        expectedDocumentVersion: 1,
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
      HostDocumentCommitSchema.parse(
        (await f.host.command(f.author, differentClient)).result,
      ).version,
    ).toBe(2);
    const differentPrincipal = access("agent", ["author"]);
    const newPrincipalCommand = f.command(
      "document.mutate",
      {
        reviewId: f.created.review.id,
        expectedDocumentVersion: 2,
        operations: [prose("second")],
      },
      request.commandId,
    );
    expect(
      HostDocumentCommitSchema.parse(
        (await f.host.command(differentPrincipal, newPrincipalCommand)).result,
      ).version,
    ).toBe(3);
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
        expectedDocumentVersion: 0,
        operations: [prose()],
      },
      failed.commandId,
    );
    expect(
      HostDocumentCommitSchema.parse(
        (await f.host.command(f.author, corrected)).result,
      ).version,
    ).toBe(1);
  });

  it("keeps metadata and document version checks independent and returns sparse, re-applicable commits", async () => {
    const f = await fixture();
    await f.mutate(0, [prose(), ...anchor()]);
    const before = f.store.document(f.created.review.id);
    await f.host.command(
      f.author,
      f.command("review.update", {
        reviewId: f.created.review.id,
        expectedVersion: 0,
        title: "New title",
        description: "New description",
        labels: ["storage"],
      }),
    );
    expect(f.store.document(f.created.review.id)).toEqual(before);
    const commit = await f.mutate(1, [
      {
        op: "node.replace",
        node: {
          id: "intro",
          type: "markdown",
          markdown: "Updated explanation",
        },
      },
    ]);
    expect(Object.keys(commit.changedNodes)).toEqual(["intro"]);
    expect(commit.changedDefinitions).toEqual({});
    expect(commit.changedEvidence).toEqual({});
    expect(commit.previousVersion).toBe(1);
    expect(commit.version).toBe(2);
    const reconstructed = {
      ...before,
      nodes: { ...before.nodes, ...commit.changedNodes },
      version: commit.version,
      contentHash: commit.contentHash,
      createdAt: commit.createdAt,
      roots: commit.roots,
      binding: commit.binding,
    };
    expect(reconstructed).toEqual(f.store.document(f.created.review.id));
    expect(f.store.review(f.created.review.id)).toMatchObject({
      version: 1,
      documentVersion: 2,
      title: "New title",
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
      previousVersion: 1,
      version: 1,
      changedNodes: {},
      changedDefinitions: {},
      changedEvidence: {},
    });
    expect(f.store.cursor()).toBe(beforeNoop);
    const removed = await f.mutate(1, [
      { op: "node.remove", nodeId: "source_peek", subtree: false },
      { op: "definition.remove", id: "source" },
    ]);
    expect(removed.removedNodeIds).toEqual(["source_peek"]);
    expect(removed.removedDefinitionIds).toEqual(["source"]);
    expect(removed.removedEvidenceIds).toEqual(["source"]);
    const old = await f.host.query(
      f.author,
      f.query("document.evidence", {
        reviewId: f.created.review.id,
        version: 1,
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
          version: 2,
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
    expect(Object.keys(commit.changedNodes)).toEqual(["first", "second"]);
    const events = f.host.events(
      f.author,
      f.store.workspaceId,
      before,
      f.created.review.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "document.resync_required",
      payload: { reviewId: f.created.review.id, version: 1 },
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
    expect(snapshot.nodes).toEqual(commit.changedNodes);
  });

  it("validates proposed edits without committing and reports errors against their exact source version", async () => {
    const f = await fixture();
    const baseline = counts(f.databasePath);
    const validate = (operations: HostDocumentOperation[]) =>
      f.host.query(
        f.author,
        f.query("document.validate", {
          reviewId: f.created.review.id,
          expectedDocumentVersion: 0,
          operations,
        }),
      );
    const valid = HOST_QUERY_DEFINITIONS["document.validate"].result.parse(
      (await validate(anchor())).result,
    );
    expect(valid).toMatchObject({
      valid: true,
      basedOnVersion: 0,
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
    expect(invalid.basedOnVersion).toBe(0);
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
    expect(counts(f.databasePath)).toEqual(baseline);
  });
});

describe("ReviewHost immutable publication and queries", () => {
  it("reports rejected publications without changing errors or successful receipts", async () => {
    const f = await fixture();
    let rejections = 0;
    const host = new ReviewHost(f.store, {
      onPublishRejected: () => {
        rejections += 1;
        throw new Error("Telemetry unavailable");
      },
    });
    await expect(
      host.command(f.author, f.publish(99, 0)),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(rejections).toBe(1);
    const request = f.publish(0, 0);
    const accepted = await host.command(f.author, request);
    expect(await host.command(f.author, request)).toEqual(accepted);
    expect(rejections).toBe(1);
  });

  it("keeps checkpoints, titles, and source evidence immutable after updates and restore without the source checkout", async () => {
    const f = await fixture();
    await f.mutate(0, [prose(), ...anchor()]);
    const historical = f.store.document(f.created.review.id);
    const checkpoint1 = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (await f.host.command(f.author, f.publish(1, 0))).result,
    );
    await f.host.command(
      f.author,
      f.command("review.update", {
        reviewId: f.created.review.id,
        expectedVersion: 1,
        title: "Revised title",
        description: "Revised description",
        labels: [],
      }),
    );
    const empty = { schemaVersion: 1, roots: [], nodes: {}, definitions: {} };
    await f.host.command(
      f.author,
      f.command("document.replace", {
        reviewId: f.created.review.id,
        expectedDocumentVersion: 1,
        document: empty,
      }),
    );
    const checkpoint2 = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (await f.host.command(f.author, f.publish(2, 2))).result,
    );
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const restored = HostDocumentCommitSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("document.restore", {
            reviewId: f.created.review.id,
            expectedDocumentVersion: 2,
            fromVersion: 1,
          }),
        )
      ).result,
    );
    expect(restored).toMatchObject({
      previousVersion: 2,
      version: 3,
      contentHash: historical.contentHash,
      changedEvidence: historical.evidence,
    });
    expect(documentInput(f.store.document(f.created.review.id))).toEqual(
      documentInput(historical),
    );
    expect(f.store.document(f.created.review.id).binding).toEqual(
      historical.binding,
    );
    expect(f.store.review(f.created.review.id)).toMatchObject({
      title: "Revised title",
      version: 3,
      documentVersion: 3,
      publishedCheckpointId: checkpoint2.id,
    });
    const original = HOST_QUERY_DEFINITIONS["checkpoint.get"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("checkpoint.get", {
            reviewId: f.created.review.id,
            checkpointId: checkpoint1.id,
          }),
        )
      ).result,
    );
    expect(original.checkpoint).toEqual(checkpoint1);
    expect(original.document).toEqual(historical);
    expect(checkpoint1.title).toBe("Shared review database");
    expect(checkpoint2).toMatchObject({
      title: "Revised title",
      ordinal: 2,
      documentVersion: 2,
    });
    expect(f.store.checkpoint(f.created.review.id, checkpoint2.id)).toEqual(
      checkpoint2,
    );
    closeStore(f.store);
    const restarted = openStore(f.databasePath);
    expect(restarted.checkpoint(f.created.review.id, checkpoint1.id)).toEqual(
      checkpoint1,
    );
    expect(
      restarted.document(f.created.review.id, checkpoint1.documentVersion),
    ).toEqual(historical);
  });

  it("rejects stale publication atomically and scopes checkpoint IDs to their review", async () => {
    const f = await fixture();
    const other = await f.create("Other review");
    await f.mutate(0, [prose()]);
    const baseline = counts(f.databasePath);
    await expect(
      f.host.command(f.author, f.publish(0, 0)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      f.host.command(f.author, f.publish(1, 1)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(counts(f.databasePath)).toEqual(baseline);
    const published = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (await f.host.command(f.author, f.publish(1, 0))).result,
    );
    await expect(
      f.host.query(
        f.author,
        f.query("checkpoint.get", {
          reviewId: other.review.id,
          checkpointId: published.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects retired IDs in replacements while permitting explicit historical restoration", async () => {
    const f = await fixture();
    await f.mutate(0, [prose()]);
    const old = documentInput(f.store.document(f.created.review.id));
    await f.mutate(1, [{ op: "node.remove", nodeId: "intro", subtree: false }]);
    await expect(
      f.host.command(
        f.author,
        f.command("document.replace", {
          reviewId: f.created.review.id,
          expectedDocumentVersion: 2,
          document: old,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await f.host.command(
      f.author,
      f.command("document.restore", {
        reviewId: f.created.review.id,
        expectedDocumentVersion: 2,
        fromVersion: 1,
      }),
    );
    expect(documentInput(f.store.document(f.created.review.id))).toEqual(old);
  });

  it("pages immutable history/checkpoints without offsets and rejects a cursor for a different query", async () => {
    const f = await fixture();
    await f.mutate(0, [prose()]);
    await f.host.command(f.author, f.publish(1, 0));
    await f.mutate(1, [prose("second")]);
    await f.host.command(f.author, f.publish(2, 1));
    const readHistory = async (input: JsonValue) =>
      HOST_QUERY_DEFINITIONS["document.history"].result.parse(
        (await f.host.query(f.author, f.query("document.history", input)))
          .result,
      );
    const first = await readHistory({
      reviewId: f.created.review.id,
      limit: 1,
    });
    expect(first.items.map((version) => version.version)).toEqual([2]);
    expect(first.nextCursor).not.toBeNull();
    await f.mutate(2, [prose("third")]);
    const second = await readHistory({
      reviewId: f.created.review.id,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((version) => version.version)).toEqual([1, 0]);
    expect(second.nextCursor).toBeNull();
    const other = await f.create("Other review");
    await expect(
      readHistory({ reviewId: other.review.id, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(
      f.host.query(
        f.author,
        f.query("checkpoints.list", {
          reviewId: f.created.review.id,
          cursor: first.nextCursor,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    const checkpoints = HOST_QUERY_DEFINITIONS["checkpoints.list"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("checkpoints.list", {
            reviewId: f.created.review.id,
            limit: 1,
          }),
        )
      ).result,
    );
    expect(checkpoints.items.map((checkpoint) => checkpoint.ordinal)).toEqual([
      2,
    ]);
    const next = HOST_QUERY_DEFINITIONS["checkpoints.list"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("checkpoints.list", {
            reviewId: f.created.review.id,
            cursor: checkpoints.nextCursor,
          }),
        )
      ).result,
    );
    expect(next.items.map((checkpoint) => checkpoint.ordinal)).toEqual([1]);
  });

  it("returns a document snapshot cursor that lets clients catch up and filters private events", async () => {
    const f = await fixture();
    const snapshot = await f.host.query(
      f.author,
      f.query("document.get", { reviewId: f.created.review.id }),
    );
    const first = HostDocumentStateSchema.parse(snapshot.result);
    expect(first.version).toBe(0);
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
      "document.committed",
      "private.feedback",
    ]);
    expect(events[0]?.payload).toMatchObject({
      commit: { previousVersion: first.version, version: 1 },
    });
    expect(events[1]?.payload).toEqual({ text: "Author's private draft" });
    const current = await f.host.query(
      f.author,
      f.query("document.get", { reviewId: f.created.review.id }),
    );
    expect(HostDocumentStateSchema.parse(current.result).version).toBe(1);
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
