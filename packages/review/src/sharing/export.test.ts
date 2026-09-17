import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeStoreAuth } from "@dev.fast/trace-core";
import { afterEach, expect, it, vi } from "vitest";

import { createReviewApi } from "../review-api/http.js";
import { openLocalReviewStore } from "../review-api/local-data.js";
import { attachedSource } from "./clone.js";
import { exportShare } from "./export.js";
import { SharedReviewStore, validateShareBundle } from "./import.js";

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
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repo, "main.ts"), "export const answer = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "main.ts"), "export const answer = 2;\n");
  await writeFile(path.join(repo, "new.ts"), "export const added = true;\n");
  git("add", ".");
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
      source: { side: "head", file: "main.ts", fromLine: 1, toLine: 1 },
    },
    {
      type: "code_peek",
      source: { side: "head", file: "new.ts", fromLine: 1, toLine: 1 },
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

it("retains exact source versions and the referenced conversation after the repository disappears", async () => {
  const { local, reviewId, root, repo } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));

  const id = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  await local.data.close();
  await rename(repo, path.join(root, "unavailable"));
  const saved = await imported.read(id);
  expect(validateShareBundle(saved).snapshot.title).toBe("A shared review");

  const base = saved.manifest.files.find(
    (file) => file.file === "main.ts" && file.side === "base",
  )!;

  expect(Buffer.from(saved.objects.get(base.object!)!).toString()).toBe(
    "export const answer = 1;\n",
  );
  expect(
    saved.manifest.files.find(
      (file) => file.file === "new.ts" && file.side === "base",
    )?.object,
  ).toBeNull();

  const trace = saved.manifest.resources.find(
    (resource) => resource.kind === "trace",
  )!;

  expect(
    JSON.parse(Buffer.from(saved.objects.get(trace.object)!).toString()).events,
  ).toHaveLength(2);
});

it("rejects tampered bytes and keeps identical local resource IDs isolated by share", async () => {
  const { local, reviewId, root } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));
  const a = await imported.import("https://app.dev.fast", randomUUID(), bundle);
  const b = await imported.import("https://app.dev.fast", randomUUID(), bundle);
  expect(a).not.toBe(b);
  const corrupt = { ...bundle, objects: new Map(bundle.objects) };
  corrupt.objects.set(bundle.manifest.snapshot, Buffer.from("{}"));
  await expect(
    imported.import("https://app.dev.fast", randomUUID(), corrupt),
  ).rejects.toThrow("corrupt");
  expect(validateShareBundle(await imported.read(a)).snapshot.reviewId).toBe(
    reviewId,
  );
});

it("serves pinned files and scoped resources through the API while rejecting shared mutations", async () => {
  const { local, reviewId, root } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));

  const id = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  const app = createReviewApi(local.store, local.data, undefined, imported);
  const file = await app.request(`/${id}/file?side=head&file=main.ts`);
  expect(file.status).toBe(200);
  expect((await file.json()).text).toBe("export const answer = 2;\n");

  const attachment = await app.request(
    `/${id}/source-attachment?side=head&file=main.ts`,
  );

  expect(await attachment.json()).toEqual({});
  expect((await app.request(`/${id}/tree?side=invalid`)).status).toBe(400);
  expect(
    (await app.request(`/${id}/file?side=head&file=main.ts&version=999`))
      .status,
  ).toBe(404);
  expect(
    (await app.request(`/${id}/activity`, { method: "POST" })).status,
  ).toBe(409);
  const traceId = bundle.manifest.resources[0]!.id;
  expect((await app.request(`/resources/${traceId}`)).status).toBe(404);
  expect((await app.request(`/${id}/resources/${traceId}`)).status).toBe(200);
  expect((await app.request(`/${id}/resources/not-included`)).status).toBe(404);

  const mutation = await app.request("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: randomUUID(),
      operation: { type: "rename", reviewId: id, title: "Changed" },
    }),
  });

  expect(mutation.status).toBe(409);
  expect(local.store.list()).toHaveLength(1);
  expect(imported.get(id).snapshot.title).toBe("A shared review");
  const restart = new SharedReviewStore(imported.root);
  await restart.load();
  expect(restart.list()[0]?.reviewId).toBe(id);
});

it("isolates a corrupt cached share without preventing other reviews from opening", async () => {
  const { local, reviewId, root } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));

  const a = await imported.import("https://app.dev.fast", randomUUID(), bundle),
    b = await imported.import("https://app.dev.fast", randomUUID(), bundle);

  await writeFile(
    path.join(imported.root, a, bundle.manifest.snapshot),
    "corrupt",
  );
  const restart = new SharedReviewStore(imported.root);
  await restart.load();
  expect(restart.list().map((review) => review.reviewId)).toEqual([b]);
  expect(restart.get(b).snapshot.title).toBe("A shared review");
});

it("uses an attached file only while it matches the immutable snapshot", async () => {
  const { local, reviewId, root } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));

  const id = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  const nativeRoot = path.join(imported.root, ".repositories", `${id}-head`);
  await mkdir(nativeRoot, { recursive: true });
  const file = path.join(nativeRoot, "main.ts");
  await writeFile(file, "export const answer = 2;\n");
  expect(
    (await attachedSource(imported, id, "head", "main.ts"))?.localPath,
  ).toBe(await realpath(file));
  await writeFile(file, "export const answer = 99;\n");
  expect(await attachedSource(imported, id, "head", "main.ts")).toBeUndefined();

  const entry = bundle.manifest.files.find(
    (value) => value.side === "head" && value.file === "main.ts",
  )!;

  expect((await imported.readObject(id, entry.object!)).toString()).toBe(
    "export const answer = 2;\n",
  );
});

it("removes the clone and both checkouts before reimporting a deleted share", async () => {
  const { local, reviewId, root } = await fixture();
  const bundle = await exportShare({ ...local, reviewId });
  const imported = new SharedReviewStore(path.join(root, "shared"));
  const shareId = randomUUID();
  const id = await imported.import("https://app.dev.fast", shareId, bundle);

  const paths = [id, `${id}-base`, `${id}-head`].map((name) =>
    path.join(imported.root, ".repositories", name),
  );

  for (const dir of paths) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stale"), "old checkout");
  }

  await imported.removeLocal(id);

  for (const dir of paths)
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await imported.import("https://app.dev.fast", shareId, bundle)).toBe(
    id,
  );
  expect(imported.get(id).snapshot.title).toBe("A shared review");
});

it("returns actionable export errors through the publishing endpoint", async () => {
  const { local, reviewId, root } = await fixture();
  vi.stubEnv("DEV_REVIEW_HOME", root);
  await writeStoreAuth({
    origin: "https://app.dev.fast",
    token: "fixture",
    login: "fixture",
    savedAt: new Date().toISOString(),
  });
  await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "markdown",
          markdown: "![unmanaged](https://example.invalid/image.png)",
        },
      },
    },
  });

  const app = createReviewApi(
    local.store,
    local.data,
    undefined,
    new SharedReviewStore(path.join(root, "shared")),
  );

  const response = await app.request("/sharing/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewId }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Convert Markdown images to managed image blocks before sharing.",
  });
});
