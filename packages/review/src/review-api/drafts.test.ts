import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ReviewInputError } from "./document.js";
import type { Draft } from "./drafts.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base", head: "head" };

const command = <T>(operation: T) => ({ commandId: randomUUID(), operation });

let directory: string, database: string, a: ReviewStore, b: ReviewStore;

let providers: ReviewProviders;

const draft = async (store: ReviewStore, reviewId?: string) => {
  const result = await store.executeDraft({
    type: "begin",
    reviewId,
    title: "Draft",
    pins,
  });

  if (!("draftId" in result) || !("document" in result))
    throw new Error("Expected draft");

  return result;
};

const write = (d: Draft, text: string) =>
  a.executeDraft({
    type: "write",
    draftId: d.draftId,
    document: [{ type: "markdown", markdown: text }],
  });

const commit = (d: Draft) => ({
  type: "commit",
  draftId: d.draftId,
  commandId: randomUUID(),
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "review-drafts-"));
  database = path.join(directory, "reviews.db");
  providers = {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  };
  a = new ReviewStore(database, providers);
  b = new ReviewStore(database, providers);
});

afterEach(async () => {
  vi.useRealTimers();
  await a.close();
  await b.close();
  await rm(directory, { recursive: true, force: true });
});

it("keeps a new draft out of the catalog and commits one snapshot with durable retries", async () => {
  const notified: string[] = [];
  const unsubscribe = a.subscribe((result) => notified.push(result.reviewId));
  const d = await draft(a);
  await write(d, "First pass");
  await write(d, "Second pass");
  await a.executeDraft({
    type: "write",
    draftId: d.draftId,
    document: [
      {
        type: "section",
        title: "Outer",
        children: [
          {
            type: "section",
            title: "Inner",
            children: [{ type: "markdown", markdown: "Evidence" }],
          },
        ],
      },
    ],
  });
  expect(a.list()).toEqual([]);
  expect(notified).toEqual([]);
  expect(() => b.read(d.reviewId)).toThrow(/not found/i);
  const request = commit(d);
  expect(await a.executeDraft(request)).toEqual({
    reviewId: d.reviewId,
    version: 0,
  });
  expect(notified).toEqual([d.reviewId]);
  unsubscribe();
  expect(b.history(d.reviewId)).toHaveLength(1);
  expect(b.read(d.reviewId).document).toMatchObject([
    { title: "Outer", children: [{ title: "Inner" }] },
  ]);
  await a.close();
  a = new ReviewStore(database, providers);
  expect(await a.executeDraft(request)).toEqual({
    reviewId: d.reviewId,
    version: 0,
  });
  expect(a.history(d.reviewId)).toHaveLength(1);
  await expect(
    a.executeDraft({ ...request, draftId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
});

it("begins and commits a draft from a review saved with the retired section status, and rejects status in draft writes", async () => {
  const { reviewId } = await a.execute(
    command({ type: "create", title: "Saved", pins }),
  );

  await a.execute(
    command({
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "section", title: "Old", children: [] },
      },
    }),
  );
  await a.close();
  await b.close();
  const db = new DatabaseSync(database);
  db.prepare(
    `UPDATE versions SET snapshot=json_set(snapshot,'$.document[0].status','complete') WHERE review_id=?`,
  ).run(reviewId);
  db.close();
  a = new ReviewStore(database, providers);
  b = new ReviewStore(database, providers);

  const d = await draft(a, reviewId);
  expect(d.document).toEqual([
    expect.not.objectContaining({ status: expect.anything() }),
  ]);
  const sectionId = d.document[0]!.id;

  await expect(
    a.executeDraft({
      type: "edit",
      draftId: d.draftId,
      edit: {
        type: "update",
        targetId: sectionId,
        changes: { status: "complete" },
      },
    }),
  ).rejects.toThrow(/Unrecognized key/);
  await expect(async () =>
    a.executeDraft({
      type: "write",
      draftId: d.draftId,
      document: [
        { type: "section", title: "New", status: "pending", children: [] },
      ],
    }),
  ).rejects.toThrow(/Unrecognized key/);

  await a.executeDraft({
    type: "edit",
    draftId: d.draftId,
    edit: {
      type: "update",
      targetId: sectionId,
      changes: { title: "Revised" },
    },
  });
  await a.executeDraft(commit(d));
  expect(b.read(reviewId).document).toEqual([
    { id: sectionId, type: "section", title: "Revised", children: [] },
  ]);
});

it("isolates updates, reserves discarded IDs, and releases on abort and shutdown", async () => {
  const initial = await a.execute(
    command({ type: "create", title: "Saved", pins }),
  );

  const d = await draft(a, initial.reviewId);
  await write(d, "Not committed");
  const firstId = a.drafts.read(d.draftId).document[0]!.id;
  expect(b.read(d.reviewId)).toMatchObject({
    title: "Saved",
    version: 0,
    document: [],
  });
  expect(b.history(d.reviewId)).toHaveLength(1);
  await a.executeDraft({ type: "abort", draftId: d.draftId });
  const next = await draft(a, d.reviewId);
  await write(next, "Next draft");
  expect(a.drafts.read(next.draftId).document[0]!.id).not.toBe(firstId);
  const targetId = a.drafts.read(next.draftId).document[0]!.id;
  await a.executeDraft({
    type: "edit",
    draftId: next.draftId,
    edit: {
      type: "update",
      targetId,
      changes: { markdown: "Corrected draft" },
    },
  });
  expect(a.drafts.read(next.draftId).document[0]).toMatchObject({
    id: targetId,
    markdown: "Corrected draft",
  });
  expect(b.history(d.reviewId)).toHaveLength(1);
  await a.executeDraft(commit(next));
  expect(b.read(d.reviewId)).toMatchObject({
    version: 1,
    document: [{ markdown: "Corrected draft" }],
  });
  const abandoned = await draft(a, d.reviewId);
  await write(abandoned, "Discard on shutdown");
  const fresh = await draft(a);
  await a.close();
  a = new ReviewStore(database, providers);
  expect(() => a.drafts.read(fresh.draftId)).toThrow(/not found/i);
  expect(() => a.read(fresh.reviewId)).toThrow(/not found/i);
  expect((await draft(b, d.reviewId)).document).toMatchObject([
    { markdown: "Corrected draft" },
  ]);
});

it("holds ownership without heartbeats and blocks every content mutation while other reviews remain writable", async () => {
  const initial = await a.execute(
    command({ type: "create", title: "Saved", pins }),
  );

  const d = await draft(a, initial.reviewId);
  vi.useFakeTimers();
  vi.advanceTimersByTime(24 * 60 * 60 * 1000);
  await expect(draft(b, d.reviewId)).rejects.toMatchObject({ status: 409 });

  for (const operation of [
    { type: "rename", reviewId: d.reviewId, title: "Blocked" },
    {
      type: "edit",
      reviewId: d.reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Blocked" },
      },
    },
    { type: "repin", reviewId: d.reviewId, pins },
    {
      type: "set_target",
      reviewId: d.reviewId,
      target: { kind: "commits", ...pins },
    },
    { type: "restore", reviewId: d.reviewId, version: 0 },
    { type: "delete", reviewId: d.reviewId },
  ])
    await expect(b.execute(command(operation))).rejects.toMatchObject({
      status: 409,
    });
  await expect(
    b.importVersion({
      ...b.read(d.reviewId),
      pins: b.read(d.reviewId).pins!,
    }),
  ).rejects.toMatchObject({
    status: 409,
  });
  expect(() =>
    b.activity.update(d.reviewId, { action: "begin", leaseId: randomUUID() }),
  ).toThrow(/batch draft/);
  await b.execute(
    command({ type: "attention", reviewId: d.reviewId, action: "view" }),
  );
  await expect(
    b.execute(command({ type: "create", title: "Other", pins })),
  ).resolves.toMatchObject({ version: 0 });
});

it("rejects draft acquisition during an interactive session", async () => {
  const { reviewId } = await a.execute(
    command({ type: "create", title: "Saved", pins }),
  );

  const leaseId = randomUUID();
  b.activity.update(reviewId, { action: "begin", leaseId });
  await expect(draft(a, reviewId)).rejects.toMatchObject({ status: 409 });
  b.activity.update(reviewId, { action: "end", leaseId });
  await expect(draft(a, reviewId)).resolves.toMatchObject({ reviewId });
});

it("retains an invalid draft for correction while validating pins, references, sources and resources", async () => {
  const d = await draft(a);
  expect(() =>
    a.executeDraft({
      type: "write",
      draftId: d.draftId,
      document: [{ type: "unknown" }],
    }),
  ).toThrow(/Invalid input/);
  await a.executeDraft({
    type: "write",
    draftId: d.draftId,
    document: [
      {
        type: "code_peek",
        source: {
          file: "missing.ts",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 1 },
        },
      },
    ],
  });
  providers.validateSource = async () => {
    throw new ReviewInputError("Missing source");
  };

  await expect(a.executeDraft(commit(d))).rejects.toThrow("Missing source");
  expect(a.drafts.read(d.draftId).document).toHaveLength(1);
  expect(a.list()).toEqual([]);
  await a.executeDraft({
    type: "write",
    draftId: d.draftId,
    document: [
      {
        type: "sequence",
        title: "Missing actor",
        actors: { caller: "Caller" },
        steps: [
          {
            from: "caller",
            to: "missing",
            label: "Call",
            explanation: "Evidence",
          },
        ],
      },
    ],
  });
  await expect(a.executeDraft(commit(d))).rejects.toThrow(/missing/i);
  await a.executeDraft({
    type: "write",
    draftId: d.draftId,
    document: [{ type: "image", assetId: "missing", alt: "Missing resource" }],
  });
  providers.validateResource = async () => {
    throw new ReviewInputError("Missing resource");
  };

  await expect(a.executeDraft(commit(d))).rejects.toThrow("Missing resource");
  await write(d, "Corrected");
  providers.validatePins = async () => {
    throw new ReviewInputError("Missing commit; fetch it");
  };

  await expect(a.executeDraft(commit(d))).rejects.toThrow("Missing commit");
  providers.validatePins = async () => {};

  await a.executeDraft({ type: "validate", draftId: d.draftId });
  expect(a.list()).toEqual([]);
  await a.executeDraft(commit(d));
  expect(a.read(d.reviewId).document).toMatchObject([
    { markdown: "Corrected" },
  ]);
});

it.each(["version", "owner"])(
  "fences a commit whose %s changed during validation",
  async (change) => {
    const { reviewId } = await a.execute(
      command({ type: "create", title: "Saved", pins }),
    );

    const d = await draft(a, reviewId);

    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();

    providers.validatePins = async () => {
      entered.resolve();
      await release.promise;
    };

    const pending = a.executeDraft(commit(d)).catch((error: Error) => error);
    await entered.promise;
    // Simulate an out-of-band writer or ownership loss while asynchronous validation runs.
    const db = new DatabaseSync(database);

    if (change === "version")
      db.prepare("UPDATE reviews SET version=1 WHERE id=?").run(reviewId);
    else
      db.prepare("UPDATE authoring_drafts SET owner_id=? WHERE draft_id=?").run(
        randomUUID(),
        d.draftId,
      );
    release.resolve();
    expect(await pending).toMatchObject({ status: 409 });
    expect(db.prepare("SELECT count(*) AS n FROM versions").get()!.n).toBe(1);
    db.close();
  },
);

it("prevents another process taking a live draft and discards scratch only after its server is killed", async () => {
  const { reviewId } = await a.execute(
    command({ type: "create", title: "Saved", pins }),
  );

  const script = `
    import { ReviewStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    const store = new ReviewStore(process.argv[1], { validatePins:async()=>{},validateSource:async()=>{},validateResource:async()=>{} });
    try {
      const draft = await store.executeDraft({type:"begin",reviewId:process.argv[2]});
      await store.executeDraft({type:"write",draftId:draft.draftId,document:[{type:"markdown",markdown:"Orphan"}]});
      console.log(JSON.stringify(draft));
      if(process.argv[3] === "hold") setInterval(()=>{},1000); else await store.close();
    } catch(error) { console.log(JSON.stringify({status:error.status})); await store.close(); }
  `;

  const args = [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
    database,
    reviewId,
  ];

  const child = spawn(process.execPath, [...args, "hold"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const [output] = await once(child.stdout, "data");
    const owned = JSON.parse(String(output));
    expect(owned).toMatchObject({ reviewId });
    await expect(draft(a, reviewId)).rejects.toMatchObject({ status: 409 });
    const rival = await promisify(execFile)(process.execPath, args);
    expect(JSON.parse(rival.stdout)).toMatchObject({ status: 409 });
    await expect(
      b.execute(command({ type: "rename", reviewId, title: "Blocked" })),
    ).rejects.toMatchObject({ status: 409 });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const next = await draft(a, reviewId);
    expect(next.document).toEqual([]);
    expect(next.draftId).not.toBe(owned.draftId);
    expect(a.history(reviewId)).toHaveLength(1);
  } finally {
    child.kill("SIGKILL");
  }
}, 15_000);

it("requires explicit commits before batch authoring a live worktree review", async () => {
  providers.resolveTarget = async (target) => ({ target, pins });

  const { reviewId } = await a.execute(
    command({
      type: "create",
      title: "Live review",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  await expect(a.executeDraft({ type: "begin", reviewId })).rejects.toThrow(
    /Supply resolved base\/head pins/,
  );
  const d = await draft(a, reviewId);
  await write(d, "Fixed comparison");
  expect(b.read(reviewId).target?.kind).toBe("worktree");
  expect(a.drafts.source(d.draftId).target).toEqual({
    kind: "commits",
    ...pins,
  });
  await a.executeDraft(commit(d));
  expect(b.read(reviewId)).toMatchObject({
    version: 1,
    target: { kind: "commits", ...pins },
  });
});

it("blocks publishing relative file links and lets the author correct the same draft", async () => {
  const d = await draft(a);
  await write(d, "[source](src/save.ts#L2)");
  await expect(
    a.executeDraft({ type: "validate", draftId: d.draftId }),
  ).rejects.toThrow("Use [label](review-source:head/path#L10-L24)");
  await expect(a.executeDraft(commit(d))).rejects.toThrow(
    "Use [label](review-source:head/path#L10-L24)",
  );
  expect(a.list()).toEqual([]);
  await write(d, "[source](review-source:head/src/save.ts#L2)");
  await a.executeDraft(commit(d));
  expect(a.read(d.reviewId).document[0]).toMatchObject({
    markdown: "[source](review-source:head/src/save.ts#L2)",
  });
});
