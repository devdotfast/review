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
  type HostChangeSelector,
  type HostCommandName,
  HostCommandSchema,
  HostDocumentCommitSchema,
  type HostDocumentOperation,
  type HostQueryName,
  HostQuerySchema,
  HostRepinPlanSchema,
  type HostSourceRange,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { LocalEvidenceProvider } from "./evidence-provider";
import { type HostAccess, ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

const directories: string[] = [];
const stores = new Set<ReviewHostStore>();
const lines = Array.from({ length: 20 }, (_, index) => `line${index + 1}();`);
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

function git(repositoryPath: string, ...args: string[]) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repositoryPath: string, message: string) {
  git(repositoryPath, "add", "--all");
  git(
    repositoryPath,
    "commit",
    "--date=2026-09-10T10:30:00-04:00",
    "-m",
    message,
  );
  return git(repositoryPath, "rev-parse", "HEAD");
}

function writeSource(
  repositoryPath: string,
  content: string[],
  filename = "file.ts",
) {
  writeFileSync(
    path.join(repositoryPath, "src", filename),
    `${content.join("\n")}\n`,
  );
}

function source(
  side: "base" | "head",
  fromLine = 4,
  toLine = 5,
  file = "src/file.ts",
): HostSourceRange {
  return { side, file, fromLine, toLine };
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-host-repin-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  writeSource(repositoryPath, lines);
  writeFileSync(path.join(repositoryPath, "src/other.ts"), "oldOther();\n");
  writeFileSync(path.join(repositoryPath, "README.md"), "Review fixture\n");
  const base = commit(repositoryPath, "Base");
  writeSource(repositoryPath, [...lines.slice(0, -1), "feature();"]);
  const firstHead = commit(repositoryPath, "Add feature");
  writeFileSync(path.join(repositoryPath, "src/other.ts"), "newOther();\n");
  const head = commit(repositoryPath, "Update other file");
  const databasePath = path.join(directory, "review.db");
  const store = openStore(databasePath);
  const host = new ReviewHost(store);
  const author: HostAccess = {
    principal: { id: randomUUID(), kind: "agent", displayName: "Author" },
    permissions: new Set(["author", "read", "publish"]),
  };
  const human: HostAccess = {
    principal: { id: randomUUID(), kind: "human", displayName: "Reviewer" },
    permissions: new Set([
      "author",
      "read",
      "publish",
      "human",
      "register_repository",
    ]),
  };
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId: randomUUID(),
  };
  const command = (
    type: HostCommandName,
    input: JsonValue,
    commandId: string = randomUUID(),
  ) => HostCommandSchema.parse({ ...envelope, type, input, commandId });
  const query = (type: HostQueryName, input: JsonValue) =>
    HostQuerySchema.parse({ ...envelope, type, input });
  const repository = HOST_COMMAND_DEFINITIONS[
    "repository.register"
  ].result.parse(
    (
      await host.command(
        human,
        command("repository.register", { path: repositoryPath }),
      )
    ).result,
  );
  const create = async () =>
    HOST_COMMAND_DEFINITIONS["review.create"].result.parse(
      (
        await host.command(
          author,
          command("review.create", {
            repositoryId: repository.id,
            title: "Repin source review",
            description: "Pinned source",
            change: { kind: "range", baseRef: base, headRef: head },
          }),
        )
      ).result,
    );
  const { review } = await create();
  const operations: HostDocumentOperation[] = ["base", "head"].flatMap((id) => {
    const side = id === "base" ? "base" : "head";
    return [
      {
        op: "definition.put",
        id,
        value: { kind: "anchor", title: `${id} code`, source: source(side) },
      },
      {
        op: "node.insert",
        node: { id: `${id}_peek`, type: "code_peek", anchorId: id },
        placement: { parentId: null, afterId: null },
      },
    ];
  });
  await host.command(
    author,
    command("document.mutate", {
      reviewId: review.id,
      expectedDocumentVersion: 0,
      operations,
    }),
  );
  const plan = async (
    change: HostChangeSelector,
    expectedDocumentVersion = 1,
  ) => {
    const request = command("review.repin.plan", {
      reviewId: review.id,
      expectedDocumentVersion,
      change,
    });
    const response = await host.command(author, request);
    return {
      request,
      response,
      plan: HostRepinPlanSchema.parse(response.result),
    };
  };
  const apply = (
    planId: string,
    operations: HostDocumentOperation[] = [],
    expectedDocumentVersion = 1,
  ) =>
    command("review.repin.apply", {
      reviewId: review.id,
      planId,
      expectedDocumentVersion,
      operations,
    });
  return {
    directory,
    repositoryPath,
    databasePath,
    store,
    host,
    author,
    human,
    command,
    query,
    review,
    create,
    plan,
    apply,
    base,
    firstHead,
    head,
  };
}

function relocate(f: Awaited<ReturnType<typeof fixture>>) {
  git(f.repositoryPath, "switch", "-c", "updated-base", f.base);
  renameSync(
    path.join(f.repositoryPath, "src/file.ts"),
    path.join(f.repositoryPath, "src/renamed.ts"),
  );
  writeSource(f.repositoryPath, ["baseIntro();", ...lines], "renamed.ts");
  const base = commit(f.repositoryPath, "Rename and shift base");
  writeSource(
    f.repositoryPath,
    ["headIntro();", "baseIntro();", ...lines.slice(0, -1), "feature();"],
    "renamed.ts",
  );
  const head = commit(f.repositoryPath, "Shift head independently");
  return { kind: "range" as const, baseRef: base, headRef: head };
}

function editTarget(f: Awaited<ReturnType<typeof fixture>>) {
  writeSource(f.repositoryPath, [
    ...lines.slice(0, 3),
    "replacement();",
    ...lines.slice(4, -1),
    "feature();",
  ]);
  const head = commit(f.repositoryPath, "Edit anchored code");
  return { kind: "range" as const, baseRef: f.base, headRef: head };
}

function counts(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare(`SELECT
      (SELECT count(*) FROM host_content_objects) AS objects,
      (SELECT count(*) FROM host_document_versions) AS versions,
      (SELECT count(*) FROM host_document_ids) AS ids,
      (SELECT count(*) FROM host_repin_plans) AS plans,
      (SELECT count(*) FROM host_command_receipts) AS receipts,
      (SELECT count(*) FROM host_events) AS events`)
      .get();
  } finally {
    db.close();
  }
}

describe("ReviewHost durable source repinning", () => {
  it("persists a proposal without changing the document, then applies independent base/head rename offsets after restart", async () => {
    const f = await fixture();
    const original = f.store.document(f.review.id);
    const beforeCursor = f.store.cursor();
    const change = relocate(f);
    const proposed = await f.plan(change);
    expect(proposed.plan.anchorChanges).toEqual([
      {
        id: "base",
        before: source("base"),
        proposed: source("base", 5, 6, "src/renamed.ts"),
        status: "relocated",
      },
      {
        id: "head",
        before: source("head"),
        proposed: source("head", 6, 7, "src/renamed.ts"),
        status: "relocated",
      },
    ]);
    expect(proposed.plan.diagnostics).toEqual([]);
    expect(f.store.document(f.review.id)).toEqual(original);
    expect(f.store.cursor()).toBe(beforeCursor);
    closeStore(f.store);
    const store = openStore(f.databasePath);
    const host = new ReviewHost(store);
    const retrieved = HostRepinPlanSchema.parse(
      (
        await host.query(
          f.author,
          f.query("repin_plan.get", {
            reviewId: f.review.id,
            planId: proposed.plan.id,
          }),
        )
      ).result,
    );
    expect(retrieved).toEqual(proposed.plan);
    const commit = HostDocumentCommitSchema.parse(
      (await host.command(f.author, f.apply(proposed.plan.id))).result,
    );
    expect(commit).toMatchObject({
      previousVersion: 1,
      version: 2,
      changedNodes: {},
      binding: { baseCommit: change.baseRef, headCommit: change.headRef },
    });
    expect(commit.changedEvidence.base?.span).toMatchObject({
      commit: change.baseRef,
      file: "src/renamed.ts",
      fromLine: 5,
      toLine: 6,
    });
    expect(commit.changedEvidence.head?.span).toMatchObject({
      commit: change.headRef,
      file: "src/renamed.ts",
      fromLine: 6,
      toLine: 7,
    });
    expect(commit.changedEvidence.base?.text).toBe(
      original.evidence.base?.text,
    );
    expect(commit.changedEvidence.head?.text).toBe(
      original.evidence.head?.text,
    );
    expect(store.document(f.review.id, 1)).toEqual(original);
    expect(store.review(f.review.id)).toMatchObject({
      version: 0,
      documentVersion: 2,
    });
  });

  it("requires explicit corrections for edited code and preserves the published checkpoint", async () => {
    const f = await fixture();
    const original = f.store.document(f.review.id);
    const checkpoint = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (
        await f.host.command(
          f.author,
          f.command("review.publish", {
            reviewId: f.review.id,
            expectedReviewVersion: 0,
            expectedDocumentVersion: 1,
            mapVersions: { base: null, head: null },
          }),
        )
      ).result,
    );
    const proposed = await f.plan(editTarget(f));
    expect(
      proposed.plan.anchorChanges.find((anchor) => anchor.id === "head"),
    ).toMatchObject({ status: "missing", proposed: null });
    const baseline = counts(f.databasePath);
    await expect(
      f.host.command(f.author, f.apply(proposed.plan.id)),
    ).rejects.toMatchObject({
      name: "HostDocumentValidationError",
      diagnostics: [
        expect.objectContaining({
          definitionId: "head",
          code: "ANCHOR_REPIN_REQUIRED",
        }),
      ],
    });
    expect(counts(f.databasePath)).toEqual(baseline);
    const corrected = HostDocumentCommitSchema.parse(
      (
        await f.host.command(
          f.author,
          f.apply(proposed.plan.id, [
            {
              op: "definition.put",
              id: "head",
              value: {
                kind: "anchor",
                title: "Corrected head code",
                source: source("head"),
              },
            },
          ]),
        )
      ).result,
    );
    expect(corrected.changedEvidence.head?.text).toBe(
      "replacement();\nline5();",
    );
    expect(f.store.document(f.review.id, 1)).toEqual(original);
    const published = HOST_QUERY_DEFINITIONS["checkpoint.get"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("checkpoint.get", {
            reviewId: f.review.id,
            checkpointId: checkpoint.id,
          }),
        )
      ).result,
    );
    expect(published).toEqual({ checkpoint, document: original });
    expect(f.store.review(f.review.id)).toMatchObject({
      publishedCheckpointId: checkpoint.id,
      documentVersion: 2,
    });
  });

  it("revalidates replacement ranges and consumers atomically before applying a correction", async () => {
    const f = await fixture();
    const proposed = await f.plan(editTarget(f));
    const baseline = counts(f.databasePath);
    await expect(
      f.host.command(
        f.author,
        f.apply(proposed.plan.id, [
          {
            op: "definition.put",
            id: "head",
            value: {
              kind: "anchor",
              title: "Invalid range",
              source: source("head", 999, 999),
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(counts(f.databasePath)).toEqual(baseline);
    await expect(
      f.host.command(
        f.author,
        f.apply(proposed.plan.id, [{ op: "definition.remove", id: "head" }]),
      ),
    ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    expect(counts(f.databasePath)).toEqual(baseline);
    const commit = HostDocumentCommitSchema.parse(
      (
        await f.host.command(
          f.author,
          f.apply(proposed.plan.id, [
            { op: "definition.remove", id: "head" },
            { op: "node.remove", nodeId: "head_peek", subtree: false },
          ]),
        )
      ).result,
    );
    expect(commit).toMatchObject({
      version: 2,
      removedNodeIds: ["head_peek"],
      removedDefinitionIds: ["head"],
      removedEvidenceIds: ["head"],
    });
  });

  it("rejects old plans and stale document versions without changing any persisted state", async () => {
    const f = await fixture();
    const proposed = await f.plan(relocate(f));
    await f.host.command(
      f.author,
      f.command("document.mutate", {
        reviewId: f.review.id,
        expectedDocumentVersion: 1,
        operations: [
          {
            op: "node.insert",
            node: { id: "intro", type: "markdown", markdown: "A later edit" },
            placement: { parentId: null, afterId: null },
          },
        ],
      }),
    );
    const baseline = counts(f.databasePath);
    await expect(
      f.host.command(f.author, f.apply(proposed.plan.id)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      f.host.command(f.author, f.apply(proposed.plan.id, [], 2)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      f.plan({ kind: "range", baseRef: f.base, headRef: f.head }, 1),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(counts(f.databasePath)).toEqual(baseline);
  });

  it("rolls back an already-validated repin when another connection commits first", async () => {
    const f = await fixture();
    const proposed = await f.plan(relocate(f));
    const secondStore = openStore(f.databasePath);
    const entered = gate();
    const release = gate();
    const provider = new LocalEvidenceProvider((id) =>
      secondStore.repositoryPath(id),
    );
    const host = new ReviewHost(secondStore, {
      evidence: {
        async resolve(...args: Parameters<LocalEvidenceProvider["resolve"]>) {
          const quote = await provider.resolve(...args);
          entered.resolve();
          await release.promise;
          return quote;
        },
      },
    });
    const pending = host.command(f.author, f.apply(proposed.plan.id));
    await entered.promise;
    await f.host.command(
      f.author,
      f.command("document.mutate", {
        reviewId: f.review.id,
        expectedDocumentVersion: 1,
        operations: [
          {
            op: "node.insert",
            node: {
              id: "intro",
              type: "markdown",
              markdown: "Concurrent explanation",
            },
            placement: { parentId: null, afterId: null },
          },
        ],
      }),
    );
    const committed = f.store.document(f.review.id);
    const baseline = counts(f.databasePath);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(counts(f.databasePath)).toEqual(baseline);
    expect(secondStore.document(f.review.id)).toEqual(committed);
    expect(committed.binding).toMatchObject({
      baseCommit: f.base,
      headCommit: f.head,
    });
  });

  it("confines proposals to their review and denies Ask creation/application", async () => {
    const f = await fixture();
    const proposed = await f.plan(relocate(f));
    const other = await f.create();
    await expect(
      f.host.query(
        f.author,
        f.query("repin_plan.get", {
          reviewId: other.review.id,
          planId: proposed.plan.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.host.command(
        f.author,
        f.command("review.repin.apply", {
          reviewId: other.review.id,
          planId: proposed.plan.id,
          expectedDocumentVersion: 0,
          operations: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ask: HostAccess = {
      ...f.author,
      permissions: new Set(["read"]),
      reviewIds: new Set([f.review.id]),
    };
    await expect(f.host.command(ask, proposed.request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      f.host.command(ask, f.apply(proposed.plan.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.host.query(
        ask,
        f.query("source.tree", {
          reviewId: other.review.id,
          documentVersion: 0,
          side: "head",
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("replays successful plan/apply receipts with the repository offline, including after restart", async () => {
    const f = await fixture();
    const proposed = await f.plan(relocate(f));
    const request = f.apply(proposed.plan.id);
    const applied = await f.host.command(f.author, request);
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const baseline = counts(f.databasePath);
    expect(await f.host.command(f.author, proposed.request)).toEqual(
      proposed.response,
    );
    expect(await f.host.command(f.author, request)).toEqual(applied);
    closeStore(f.store);
    const restarted = new ReviewHost(openStore(f.databasePath));
    expect(await restarted.command(f.author, proposed.request)).toEqual(
      proposed.response,
    );
    expect(await restarted.command(f.author, request)).toEqual(applied);
    expect(counts(f.databasePath)).toEqual(baseline);
  });

  it("preserves document and evidence semantics when a repin selects the same exact commits", async () => {
    const f = await fixture();
    const original = f.store.document(f.review.id);
    const proposed = await f.plan({
      kind: "range",
      baseRef: f.base,
      headRef: f.head,
    });
    expect(proposed.plan.anchorChanges.map((anchor) => anchor.status)).toEqual([
      "exact",
      "exact",
    ]);
    expect(proposed.plan.proposedDefinitions).toEqual(original.definitions);
    const applied = HostDocumentCommitSchema.parse(
      (await f.host.command(f.author, f.apply(proposed.plan.id))).result,
    );
    expect(applied.changedNodes).toEqual({});
    expect(applied.changedDefinitions).toEqual({});
    expect(applied.changedEvidence).toEqual({});
    const current = f.store.document(f.review.id);
    expect(current.evidence).toEqual(original.evidence);
    expect(current.nodes).toEqual(original.nodes);
    expect(current.binding).toMatchObject({
      repositoryId: original.binding.repositoryId,
      baseCommit: f.base,
      headCommit: f.head,
    });
  });
});

describe("ReviewHost pinned source query boundary", () => {
  it("normalizes real offset-bearing commit dates and paginates commits and diffs", async () => {
    const f = await fixture();
    expect(git(f.repositoryPath, "show", "-s", "--format=%aI", f.head)).toBe(
      "2026-09-10T10:30:00-04:00",
    );
    const first = HOST_QUERY_DEFINITIONS["source.commits"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.commits", {
            reviewId: f.review.id,
            documentVersion: 1,
            limit: 1,
          }),
        )
      ).result,
    );
    expect(first.items).toEqual([
      expect.objectContaining({
        oid: f.head,
        at: "2026-09-10T14:30:00.000Z",
        subject: "Update other file",
      }),
    ]);
    const second = HOST_QUERY_DEFINITIONS["source.commits"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.commits", {
            reviewId: f.review.id,
            documentVersion: 1,
            limit: 1,
            cursor: first.nextCursor,
          }),
        )
      ).result,
    );
    expect(second.items.map((item) => item.oid)).toEqual([f.firstHead]);
    expect(second.nextCursor).toBeNull();
    const firstDiff = HOST_QUERY_DEFINITIONS["source.diff"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.diff", {
            reviewId: f.review.id,
            documentVersion: 1,
            limit: 1,
          }),
        )
      ).result,
    );
    expect(firstDiff.items).toEqual([
      expect.objectContaining({
        path: "src/file.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
      }),
    ]);
    const nextDiff = HOST_QUERY_DEFINITIONS["source.diff"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.diff", {
            reviewId: f.review.id,
            documentVersion: 1,
            cursor: firstDiff.nextCursor,
          }),
        )
      ).result,
    );
    expect(nextDiff.items.map((item) => item.path)).toEqual(["src/other.ts"]);
    await expect(
      f.host.query(
        f.author,
        f.query("source.diff", {
          reviewId: f.review.id,
          documentVersion: 1,
          cursor: first.nextCursor,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("scopes source tree page cursors by document version, side, directory, and review", async () => {
    const f = await fixture();
    const first = HOST_QUERY_DEFINITIONS["source.tree"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.tree", {
            reviewId: f.review.id,
            documentVersion: 1,
            side: "head",
            directory: "src",
            limit: 1,
          }),
        )
      ).result,
    );
    expect(first.items).toEqual([
      expect.objectContaining({ path: "src/file.ts", kind: "file" }),
    ]);
    const next = HOST_QUERY_DEFINITIONS["source.tree"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.tree", {
            reviewId: f.review.id,
            documentVersion: 1,
            side: "head",
            directory: "src",
            cursor: first.nextCursor,
          }),
        )
      ).result,
    );
    expect(next.items.map((item) => item.path)).toEqual(["src/other.ts"]);
    const other = await f.create();
    for (const mismatch of [
      { documentVersion: 0 },
      { side: "base" },
      { directory: undefined },
      { reviewId: other.review.id, documentVersion: 0 },
    ]) {
      const input = {
        reviewId: f.review.id,
        documentVersion: 1,
        side: "head",
        directory: "src",
        cursor: first.nextCursor,
        ...mismatch,
      };
      await expect(
        f.host.query(
          f.author,
          HostQuerySchema.parse({
            ...f.query("source.tree", {
              reviewId: f.review.id,
              documentVersion: 1,
              side: "head",
            }),
            input,
          }),
        ),
      ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    }
  });

  it("reads exact historical pins rather than the current checkout or current document binding", async () => {
    const f = await fixture();
    const proposed = await f.plan(relocate(f));
    await f.host.command(f.author, f.apply(proposed.plan.id));
    writeSource(f.repositoryPath, ["uncommitted poison"], "renamed.ts");
    const original = HOST_QUERY_DEFINITIONS["source.read"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.read", {
            reviewId: f.review.id,
            documentVersion: 1,
            range: source("head"),
          }),
        )
      ).result,
    );
    expect(original.span).toMatchObject({
      commit: f.head,
      file: "src/file.ts",
      fromLine: 4,
      toLine: 5,
    });
    expect(original.text).toBe("line4();\nline5();");
    const current = HOST_QUERY_DEFINITIONS["source.read"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("source.read", {
            reviewId: f.review.id,
            documentVersion: 2,
            range: source("head", 6, 7, "src/renamed.ts"),
          }),
        )
      ).result,
    );
    expect(current.span).toMatchObject({
      commit: proposed.plan.binding.headCommit,
      file: "src/renamed.ts",
      fromLine: 6,
      toLine: 7,
    });
    expect(current.text).toBe(original.text);
    await expect(
      f.host.query(
        f.author,
        f.query("source.read", {
          reviewId: f.review.id,
          documentVersion: 1,
          range: source("head", 4, 5, "src/renamed.ts"),
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() =>
      f.query("source.read", {
        reviewId: f.review.id,
        documentVersion: 1,
        range: source("head", 1, 1, "../secret"),
      }),
    ).toThrow(/file/);
  });
});
