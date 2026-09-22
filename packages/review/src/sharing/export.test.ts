import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import { selectSource } from "../lens-selection";
import { ReviewInputError } from "../review-api/document.js";
import { createReviewApi } from "../review-api/http.js";
import { openLocalReviewStore } from "../review-api/local-data.js";
import { type ShareBundle, digestBytes, exportShare } from "./export.js";
import { SharedReviewStore, validateShareBundle } from "./import.js";
import { fetchPinnedRepository } from "./repository.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-sharing-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git("init");
  git("checkout", "-b", "feature/shared-head");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repo, "main.ts"), "export const answer = 1;\n");
  await writeFile(path.join(repo, "old.ts"), "export const moved = true;\n");
  await writeFile(
    path.join(repo, "deleted.ts"),
    "export const obsolete = true;\n",
  );
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "main.ts"), "export const answer = 2;\n");
  await writeFile(path.join(repo, "new.ts"), "export const added = true;\n");
  git("add", ".");
  git("mv", "old.ts", "renamed.ts");
  git("rm", "deleted.ts");
  git("commit", "-m", "head");
  const head = git("rev-parse", "HEAD");
  const local = openLocalReviewStore(path.join(root, "review.db"));
  cleanup.push(() => local.store.close());
  cleanup.push(() => local.data.close());
  const repository = await local.data.register(repo);
  const pins = { repositoryId: repository.id, base, head };

  const created = await local.store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "A shared review", pins },
  });

  const traceId = randomUUID();
  await local.data.upload({
    kind: "trace",
    id: traceId,
    repositoryId: repository.id,
    trace: {
      label: "Retained conversation",
      events: [
        { id: "one", role: "user", text: "Change the answer." },
        { id: "two", role: "assistant", text: "Changed it to two." },
      ],
    },
  });

  for (const content of [
    {
      type: "code_peek",
      source: selectSource({
        side: "head",
        file: "main.ts",
        fromLine: 1,
        toLine: 1,
      }),
    },
    {
      type: "code_peek",
      source: selectSource({
        side: "head",
        file: "new.ts",
        fromLine: 1,
        toLine: 1,
      }),
    },
    {
      type: "trace_quote",
      traceId,
      eventId: "one",
      text: "Change the answer.",
    },
  ])
    await local.store.execute({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId: created.reviewId,
        edit: { type: "insert", content },
      },
    });

  return { root, repo, local, reviewId: created.reviewId };
}

const repository = { cloneUrl: "https://github.com/fixture/review.git" };

async function importFixture(
  prepare: (
    fixtureData: Awaited<ReturnType<typeof fixture>>,
    bundle: ShareBundle,
  ) => Promise<ShareBundle> | ShareBundle = (_, bundle) => bundle,
) {
  const fixtureData = await fixture();
  const { root, repo, local, reviewId } = fixtureData;

  const bundle = await prepare(
    fixtureData,
    await exportShare({ ...local, reviewId, repository }),
  );

  const recipient = openLocalReviewStore(path.join(root, "recipient.db"));
  cleanup.push(() => recipient.store.close());
  cleanup.push(() => recipient.data.close());

  const fetchRepository = vi.fn<typeof fetchPinnedRepository>(
    (
      target: string,
      _url: string,
      pins: Parameters<typeof fetchPinnedRepository>[2],
    ) => fetchPinnedRepository(target, repo, pins),
  );

  const imported = new SharedReviewStore(
    path.join(root, "shared"),
    fetchRepository,
  );

  imported.connect(recipient.store, recipient.data);
  await imported.load();
  const shareId = randomUUID();
  const id = await imported.import("https://app.dev.fast", shareId, bundle);

  const app = createReviewApi(
    recipient.store,
    recipient.data,
    undefined,
    imported,
  );

  return {
    ...fixtureData,
    bundle,
    imported,
    recipient,
    shareId,
    id,
    app,
    fetchRepository,
  };
}

/** Stand in for a bundle shared by an older Review: its sealed snapshot
 * carries `status` on every section. */
function withLegacySectionStatus(bundle: ShareBundle): ShareBundle {
  const snapshot = JSON.parse(
    Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
  );

  for (const block of snapshot.document)
    if (block.type === "section") block.status = "complete";
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const id = digestBytes(bytes);
  const objects = new Map(bundle.objects);
  objects.delete(bundle.manifest.snapshot);
  objects.set(id, bytes);

  return {
    ...bundle,
    objects,
    manifest: {
      ...bundle.manifest,
      snapshot: id,
      objects: bundle.manifest.objects.map((object) =>
        object.id === bundle.manifest.snapshot
          ? { id, sha256: id, size: bytes.byteLength }
          : object,
      ),
    },
  };
}

it("exports a review saved with the retired section status and imports a bundle that still carries it", async () => {
  const { imported, id, bundle } = await importFixture(
    async ({ root, local, reviewId }) => {
      const { version } = await local.store.execute({
        commandId: randomUUID(),
        operation: {
          type: "edit",
          reviewId,
          edit: {
            type: "insert",
            content: { type: "section", title: "Notes", children: [] },
          },
        },
      });

      const db = new DatabaseSync(path.join(root, "review.db"));
      db.prepare(
        `UPDATE versions SET snapshot=json_set(snapshot,'$.document[3].status','in_progress') WHERE review_id=? AND version=?`,
      ).run(reviewId, version);
      db.close();

      const exported = await exportShare({ ...local, reviewId, repository });
      const { snapshot } = validateShareBundle(exported);
      expect(snapshot.document[3]).toMatchObject({ title: "Notes" });
      expect(snapshot.document[3]).not.toHaveProperty("status");

      return withLegacySectionStatus(exported);
    },
  );

  expect(
    JSON.parse(
      Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
    ).document[3],
  ).toMatchObject({ status: "complete" });
  const shared = imported.get(id).snapshot.document[3];
  expect(shared).toMatchObject({ type: "section", title: "Notes" });
  expect(shared).not.toHaveProperty("status");
});

it("fetches pinned source into an independent repository and retains complete traces offline", async () => {
  const { bundle, imported, id, repo, app, recipient } = await importFixture();
  expect(imported.get(id).snapshot.origin?.branch).toBe("feature/shared-head");
  await rename(repo, repo + "-hidden");
  expect(
    (await (await app.request(`/${id}/file?side=head&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 2;\n");
  expect(
    (await (await app.request(`/${id}/file?side=base&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 1;\n");
  expect((await app.request(`/${id}/file?side=base&file=new.ts`)).status).toBe(
    404,
  );
  const diffs = await (await app.request(`/${id}/diff`)).json();
  expect(diffs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "new.ts", status: "added" }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted" }),
      expect.objectContaining({ path: "renamed.ts", status: "renamed" }),
    ]),
  );

  const resource = bundle.manifest.resources.find(
    (item) => item.kind === "trace",
  )!;

  const trace = await (
    await app.request(`/${id}/resources/${resource.id}`)
  ).json();

  expect(trace.events).toHaveLength(2);
  const persisted = validateShareBundle(await imported.read(id));
  expect(persisted.snapshot.pins.repositoryId).not.toBe(
    imported.get(id).snapshot.pins.repositoryId,
  );

  const restarted = new SharedReviewStore(imported.root, async () => {
    throw new Error("offline");
  });

  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list().map((entry) => entry.reviewId)).toEqual([id]);
  await restarted.prepare(id);
  expect(restarted.get(id).snapshot.title).toBe("A shared review");
});

it("uses normal source and workspace routes but rejects authoring mutations", async () => {
  const { app, id, imported, recipient, bundle } = await importFixture();
  expect((await app.request(`/${id}/tree?side=head&path=`)).status).toBe(200);
  expect((await app.request(`/${id}/tree?side=invalid`)).status).toBe(400);
  expect(
    (await app.request(`/${id}/file?side=head&file=main.ts&version=999`))
      .status,
  ).toBe(404);
  expect(
    (await app.request(`/${id}/activity`, { method: "POST" })).status,
  ).toBe(409);
  expect(
    (await app.request(`/${id}/source-attachment?side=head&file=main.ts`))
      .status,
  ).toBe(404);

  const source = await app.request(`/${id}/source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { side: "head", file: "main.ts", fromLine: 1, toLine: 1 },
    }),
  });

  expect(source.status).toBe(200);

  const language = await (
    await app.request(`/${id}/language-context?side=head`)
  ).json();

  expect(language.rootPath).toBeTruthy();
  expect(await stat(path.join(language.rootPath, "main.ts"))).toBeTruthy();
  expect((await app.request(`/${id}/resources/not-included`)).status).toBe(404);
  expect(
    (await app.request(`/resources/${bundle.manifest.resources[0]!.id}`))
      .status,
  ).toBe(404);

  const mutation = await app.request("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: randomUUID(),
      operation: { type: "rename", reviewId: id, title: "Changed" },
    }),
  });

  expect(mutation.status).toBe(409);
  expect(recipient.store.list()).toEqual([]);
  expect(imported.get(id).snapshot.title).toBe("A shared review");
});

it("rejects tampered bytes and keeps resource IDs isolated across shares", async () => {
  const { bundle, imported, id, app } = await importFixture();

  const other = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  expect(other).not.toBe(id);
  const corrupt = { ...bundle, objects: new Map(bundle.objects) };
  corrupt.objects.set(bundle.manifest.snapshot, Buffer.from("{}"));
  await expect(
    imported.import("https://app.dev.fast", randomUUID(), corrupt),
  ).rejects.toThrow("corrupt");
  expect(
    (
      await app.request(
        `/${other}/resources/${bundle.manifest.resources[0]!.id}`,
      )
    ).status,
  ).toBe(200);
});

it("isolates corrupt cached shares at restart", async () => {
  const { bundle, imported, id, recipient } = await importFixture();

  const other = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  await writeFile(
    path.join(imported.root, id, bundle.manifest.snapshot),
    "corrupt",
  );
  const restarted = new SharedReviewStore(imported.root);
  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list().map((entry) => entry.reviewId)).toEqual([other]);
});

it("repairs a missing checkout and removes owned workspaces before reimport", async () => {
  const { imported, id, recipient, bundle, shareId, repo, fetchRepository } =
    await importFixture();

  const checkout = imported.repositoryRoot(id);

  const paths = recipient.data.workspaces
    .list(id)
    .map((workspace) => workspace.rootPath!);

  await rm(checkout, { recursive: true, force: true });
  expect(() => imported.get(id)).toThrow("Fetch the shared repository");
  await imported.prepare(id);
  expect(fetchRepository).toHaveBeenCalledTimes(2);
  const repositoryId = imported.get(id).snapshot.pins.repositoryId;
  await imported.removeLocal(id);

  for (const target of [checkout, ...paths])
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => recipient.store.repositoryPath(repositoryId)).toThrow(
    "not registered",
  );
  expect(await stat(path.join(repo, ".git"))).toBeTruthy();
  expect(await imported.import("https://app.dev.fast", shareId, bundle)).toBe(
    id,
  );
});

it("retains failed imports for retry and deduplicates preparation", async () => {
  const { local, root, repo, reviewId } = await fixture();
  const bundle = await exportShare({ ...local, reviewId, repository });
  let available = false;

  const fetcher = vi.fn<typeof fetchPinnedRepository>(
    async (
      target: string,
      _url: string,
      pins: Parameters<typeof fetchPinnedRepository>[2],
    ) => {
      if (!available)
        throw new ReviewInputError(
          "Configure Git credentials, then retry.",
          409,
        );
      await fetchPinnedRepository(target, repo, pins);
    },
  );

  const imported = new SharedReviewStore(path.join(root, "retry"), fetcher);
  imported.connect(local.store, local.data);
  await imported.load();
  const shareId = randomUUID();
  await expect(
    imported.import("https://app.dev.fast", shareId, bundle),
  ).rejects.toThrow("Configure Git credentials");
  const { sharedReviewId } = await import("./import.js");
  const id = sharedReviewId("https://app.dev.fast", shareId);
  expect(imported.status(id).stage).toBe("error");
  expect(imported.list()).toEqual([]);
  available = true;
  await Promise.all([imported.prepare(id), imported.prepare(id)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(imported.get(id).snapshot.title).toBe("A shared review");
});

it("does not expose an interrupted import before validation finishes", async () => {
  const { imported, id, recipient } = await importFixture();
  const repositoryId = imported.get(id).snapshot.pins.repositoryId;
  await writeFile(
    path.join(imported.root, id, "repository.json"),
    JSON.stringify({ repositoryId, ready: false }),
  );
  const restarted = new SharedReviewStore(imported.root);
  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list()).toEqual([]);
  await restarted.prepare(id);
  expect(restarted.get(id).snapshot.pins.repositoryId).toBe(repositoryId);
});

it("keeps the published snapshot and code after author edits and branch movement", async () => {
  const { local, repo, reviewId, imported, id, app } = await importFixture();
  const before = imported.get(id).snapshot;
  await writeFile(path.join(repo, "main.ts"), "export const answer = 999;\n");
  execFileSync("git", ["commit", "-am", "Later branch change"], {
    cwd: repo,
    stdio: "pipe",
  });
  await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Later author edit" },
      },
    },
  });
  expect(imported.get(id).snapshot).toEqual(before);
  expect(
    (await (await app.request(`/${id}/file?side=head&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 2;\n");
});

it("requires a pinned review before sharing saved worktree changes", async () => {
  const { local, reviewId, repo } = await fixture();
  const snapshot = local.store.read(reviewId);
  await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "set_target",
      reviewId,
      target: {
        kind: "worktree",
        repositoryId: snapshot.pins!.repositoryId,
        base: snapshot.pins!.base,
      },
    },
  });
  await writeFile(path.join(repo, "main.ts"), "export const answer = 99;\n");
  await expect(exportShare({ ...local, reviewId, repository })).rejects.toThrow(
    "Pin this review to commits before sharing it.",
  );
  await local.store.execute({
    commandId: randomUUID(),
    operation: { type: "repin", reviewId, pins: snapshot.pins },
  });
  const bundle = await exportShare({ ...local, reviewId, repository });
  expect(validateShareBundle(bundle).snapshot.pins.head).toBe(
    snapshot.pins!.head,
  );
});

it("counts a shared review's changed lines without a local review row", async () => {
  const { id, app } = await importFixture();
  // Textual mode exercises this without shelling out to diffr, which other
  // progress tests in this suite avoid the same way (see local-data.test.ts).
  const response = await app.request(`/${id}/progress?mode=textual`);
  expect(response.status).toBe(200);
  const progress = await response.json();
  expect(progress.complete).not.toBe(false);
  expect(progress.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "new.ts" }),
      expect.objectContaining({ path: "deleted.ts" }),
    ]),
  );
});

it("lists and streams shared diff counts with the same mode and persistence as local reviews", async () => {
  const { app, id, imported, recipient, local, reviewId, root } =
    await importFixture();

  const readCatalog = async (mode: string) =>
    await (await app.request(`/?mode=${mode}`)).json();

  expect((await readCatalog("textual"))[0].diffStats).toBeNull();

  const response = await app.request(
    "/watch?subscriptions=" +
      encodeURIComponent(JSON.stringify([{ reviewId: null, mode: "textual" }])),
  );

  const reader = response.body!.getReader();

  const next = async () =>
    JSON.parse(new TextDecoder().decode((await reader.read()).value));

  try {
    expect((await next())[0].value[0].diffStats).toBeNull();
    expect((await app.request(`/${id}/progress?mode=textual`)).status).toBe(
      200,
    );

    const pins = local.store.read(reviewId).pins!;
    await local.data.coverage(reviewId, pins, "textual");
    const expected = local.store.list("textual")[0].diffStats;

    expect(expected).toMatchObject({ fileCount: 4 });
    expect((await next())[0].value[0].diffStats).toEqual(expected);
    expect((await readCatalog("textual"))[0].diffStats).toEqual(expected);
    expect((await readCatalog("structural"))[0].diffStats).toBeNull();

    const sharedPins = imported.get(id).snapshot.pins;
    const structural = { fileCount: 4, additions: 1, deletions: 1 };
    recipient.store.setDiffStats(sharedPins, structural, "structural");
    expect((await readCatalog("structural"))[0].diffStats).toEqual(structural);
    expect((await readCatalog("textual"))[0].diffStats).toEqual(expected);

    await recipient.data.close();

    const reopened = openLocalReviewStore(path.join(root, "recipient.db"));
    cleanup.push(() => reopened.store.close());
    cleanup.push(() => reopened.data.close());
    const restored = new SharedReviewStore(imported.root);
    restored.connect(reopened.store, reopened.data);
    await restored.load();

    const restarted = createReviewApi(
      reopened.store,
      reopened.data,
      undefined,
      restored,
    );

    expect(
      (await (await restarted.request("/?mode=textual")).json())[0].diffStats,
    ).toEqual(expected);
  } finally {
    await reader.cancel();
  }
});
