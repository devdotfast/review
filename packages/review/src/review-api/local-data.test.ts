import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setLocalVcsCommandObserver } from "@dev.fast/local-vcs";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "../server/desktop-server.js";
import type { Pins } from "./document.js";
import { createReviewApi } from "./http.js";
import { openLocalReviewStore } from "./local-data.js";

let directory: string, repository: string, database: string, pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const source = {
  side: "head" as const,
  file: "example.ts",
  fromLine: 1,
  toLine: 2,
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

const spawns: string[][] = [];

const recordSpawns = () => {
  spawns.length = 0;
  setLocalVcsCommandObserver({
    start: ({ file, args }) => {
      spawns.push([file, ...args]);

      return () => {};
    },
  });
};

const batchProcesses = () =>
  spawnSync("pgrep", ["-P", String(process.pid), "-f", "cat-file"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);

const isJjRootProbe = (spawn: string[] | undefined) =>
  spawn?.[0] === "jj" && spawn[3] === "root";

/** Detection = the jj probe followed by the git probe; a lone git probe is the fallback check. */
const detections = () =>
  spawns.filter(
    (spawn, index) =>
      isJjRootProbe(spawn) ||
      (spawn[0] === "git" &&
        spawn[4] === "--show-toplevel" &&
        isJjRootProbe(spawns[index - 1])),
  );

const detectionPair = (root: string) => [
  ["jj", "-R", root, "root", "--ignore-working-copy"],
  ["git", "-C", root, "rev-parse", "--show-toplevel"],
];

const insert = <Content>(reviewId: string, content: Content) =>
  local.store.execute(
    command({
      type: "edit",
      reviewId,
      edit: { type: "insert", content },
    }),
  );

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-local-data-"));
  repository = path.join(directory, "repository");
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  mkdirSync(repository);
  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Base");
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 2;\nexport const saved = true;\n",
  );
  writeFileSync(path.join(repository, "literal[1].ts"), "exact filename\n");
  writeFileSync(path.join(repository, "literal1.ts"), "wrong pattern match\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Head");
  writeFileSync(
    path.join(repository, source.file),
    "uncommitted text must never appear\n",
  );
  local = openLocalReviewStore(database);
  const registered = await local.data.register(repository);
  pins = await local.data.resolvePins(registered.id, "HEAD^", "HEAD");
});

afterEach(async () => {
  setLocalVcsCommandObserver(null);
  await local.store.close();
  await local.data.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("lists the full repository path and hydrates diff counts from pinned commits", async () => {
  await local.store.execute(
    command({ type: "create", title: "Home metadata", pins }),
  );
  const app = createReviewApi(local.store, local.data);
  const first = await (await app.request("/")).json();
  expect(first[0].repositoryPath).toBe(realpathSync(repository));
  await local.data.populateCatalogStats();
  const ready = await (await app.request("/")).json();
  expect(ready[0].diffStats).toEqual({
    fileCount: 3,
    additions: 4,
    deletions: 1,
  });
  // Working-tree edits and attention changes cannot alter an immutable pinned diff.
  await local.store.execute(
    command({ type: "attention", reviewId: ready[0].reviewId, action: "view" }),
  );
  await local.data.populateCatalogStats();
  expect(local.store.list()[0]?.diffStats).toEqual(ready[0].diffStats);
});

it("borrows the registered worktree for language services without changing pinned reads or local edits", async () => {
  const created = await local.store.execute(
    command({ type: "create", title: "Local LSP", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  const before = git("status", "--porcelain");
  const worktrees = git("worktree", "list", "--porcelain");

  const response = await app.request(
    `/${created.reviewId}/language-context?version=0`,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ rootPath: realpathSync(repository) });
  expect((await local.data.file(pins, "head", source.file)).text).toContain(
    "export const value = 2",
  );
  expect(git("status", "--porcelain")).toBe(before);
  expect(git("worktree", "list", "--porcelain")).toBe(worktrees);
  expect(
    (await app.request(`/${created.reviewId}/language-context?version=999`))
      .status,
  ).toBe(404);
  rmSync(repository, { recursive: true });
  expect(
    await (
      await app.request(`/${created.reviewId}/language-context?version=0`)
    ).json(),
  ).toEqual({ rootPath: null });
});

it("returns map endpoint locations through HTTP and allows correcting a rejected upload", async () => {
  const app = createReviewApi(local.store, local.data);
  const edge = { kind: "semantic", from: "api", to: "missing" };

  const upload = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          containers: { api: { components: { handler: {} } }, db: {} },
          relationships: [edge],
        },
      },
      relationships: [
        { kind: "semantic", from: "app.api.handler", to: "app.db" },
      ],
    },
  };

  const send = () =>
    app.request("/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upload),
    });

  const rejected = await send();
  expect(rejected.status).toBe(400);
  const { error } = await rejected.json();
  expect(error).toContain("relationships[0] at app.to");
  expect(error).toContain('"missing"');
  expect(error).toContain("does not match an element path");
  expect(() => local.store.resource(upload.id)).toThrow(/not found/);

  edge.to = "db";
  expect((await send()).status).toBe(200);

  const saved = JSON.parse(
    Buffer.from(local.store.resource(upload.id).data).toString(),
  );

  expect(saved.relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: "app.api", to: "app.db" }),
      expect.objectContaining({ from: "app.api.handler", to: "app.db" }),
    ]),
  );
});

it("preserves map element and range details in upload errors", async () => {
  await expect(
    local.data.upload({
      id: randomUUID(),
      repositoryId: pins.repositoryId,
      kind: "map",
      pins,
      side: "head",
      model: {
        systems: {
          app: {
            containers: {
              api: {
                components: {
                  handler: {
                    codeElements: {
                      save: {
                        sourceRanges: [
                          { file: source.file, fromLine: 2, toLine: 1 },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(
    /app\.api\.handler\.save.*sourceRanges\[0\].*fromLine <= toLine/,
  );
});

it("validates Markdown source links against the pinned files before saving", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Links", pins }),
  );

  await insert(reviewId, {
    type: "markdown",
    markdown:
      "[base](review-source:base/example.ts#L1) and [head](review-source:head/example.ts#L1-L2)",
  });
  const saved = local.store.read(reviewId);

  for (const href of [
    "review-source:base/example.ts#L3",
    "review-source:head/missing.ts#L1",
    "review-source:head/../secret.ts#L1",
    "review-source:head/%2Fetc%2Fpasswd#L1",
  ]) {
    await expect(
      insert(reviewId, { type: "markdown", markdown: `[bad](${href})` }),
    ).rejects.toThrow(Error);
    expect(local.store.read(reviewId)).toEqual(saved);
  }
});

it("lists the version's commits and reads a selected commit's diff against its parent", async () => {
  const firstHead = pins.head;
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Second head");

  const updatedPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.base,
    "HEAD",
  );

  const review = await local.store.execute(
    command({ type: "create", title: "Two commits", pins: updatedPins }),
  );

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const route = `/reviews-api/${review.reviewId}`;

  const commits = await (
    await app.request(`${route}/commits?version=0`)
  ).json();

  expect(commits.map((item: { commit: string }) => item.commit)).toEqual([
    updatedPins.head,
    firstHead,
  ]);
  const selected = `version=0&commit=${firstHead}`;

  const file = await (
    await app.request(`${route}/file?${selected}&side=head&file=example.ts`)
  ).json();

  expect(file.text).toContain("value = 2");

  const patch = await (
    await app.request(`${route}/diff?${selected}&file=example.ts`)
  ).json();

  expect(patch).toContain("-export const value = 1;");
  expect(patch).toContain("+export const value = 2;");
  expect(patch).not.toContain("value = 3");
  expect((await app.request(`${route}/diff?commit=${pins.base}`)).status).toBe(
    404,
  );
  await local.store.execute(
    command({
      type: "repin",
      reviewId: review.reviewId,
      pins: { ...updatedPins, base: firstHead },
    }),
  );
  expect((await app.request(`${route}/diff?commit=${firstHead}`)).status).toBe(
    404,
  );
  expect((await app.request(`${route}/diff?${selected}`)).status).toBe(200);
});

it("reads each version of one review at its own pins", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Versions", pins }),
  );

  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  const first = local.store.read(reviewId, 0).pins;
  const second = local.store.read(reviewId, 1).pins;

  expect([first, second]).toEqual([pins, later]);
  expect((await local.data.commits(first)).map((item) => item.commit)).toEqual([
    pins.head,
  ]);
  expect((await local.data.commits(second)).map((item) => item.commit)).toEqual(
    [later.head],
  );
  expect(await local.data.comparison(first, pins.head)).toEqual(pins);
  await expect(local.data.comparison(second, pins.head)).rejects.toThrow(
    "The selected commit is not part of this review version.",
  );
  expect(await local.data.file(first, "head", source.file)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(await local.data.file(second, "head", source.file)).toMatchObject({
    commit: later.head,
    text: "export const value = 3;\n",
  });
});

it("serves a historical version's file at the pins that version was saved with", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Snapshot", pins }),
  );

  await insert(reviewId, { type: "code_peek", source });
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Third");

  const later = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await local.store.execute(command({ type: "repin", reviewId, pins: later }));
  expect(local.store.read(reviewId).version).toBe(2);

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const read = async (query: string) =>
    (
      await app.request(`/reviews-api/${reviewId}/file?side=head&${query}`)
    ).json();

  expect(await read(`version=1&file=${source.file}`)).toEqual({
    file: source.file,
    side: "head",
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(await read(`file=${source.file}`)).toEqual({
    file: source.file,
    side: "head",
    commit: later.head,
    text: "export const value = 3;\n",
  });
});

it("browses committed directories, including history, without listing untracked files", async () => {
  mkdirSync(path.join(repository, "nested", "deeper"), { recursive: true });
  writeFileSync(
    path.join(repository, "nested", "deeper", "file.ts"),
    "pinned text\n",
  );
  git("add", "nested");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Nested file");

  const nestedPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.base,
    "HEAD",
  );

  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Tree", pins: nestedPins }),
  );

  writeFileSync(path.join(repository, "untracked.ts"), "Not in the review\n");
  writeFileSync(
    path.join(repository, "nested", "deeper", "file.ts"),
    "dirty text\n",
  );

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const route = `/reviews-api/${reviewId}/tree`;
  const root = await (await app.request(route)).json();
  expect(root).toContainEqual({ path: "nested", kind: "directory" });
  expect(root).not.toContainEqual(
    expect.objectContaining({ path: "untracked.ts" }),
  );
  expect(await (await app.request(`${route}?path=nested`)).json()).toEqual([
    { path: "nested/deeper", kind: "directory" },
  ]);
  expect(
    await (await app.request(`${route}?path=nested/deeper`)).json(),
  ).toEqual([{ path: "nested/deeper/file.ts", kind: "file" }]);
  expect(
    await local.data.file(nestedPins, "head", "nested/deeper/file.ts"),
  ).toMatchObject({ text: "pinned text\n" });
  expect((await app.request(`${route}?side=base&path=nested`)).status).toBe(
    404,
  );
  expect((await app.request(`${route}?path=../outside`)).status).toBe(400);
  expect((await app.request(`${route}?path=example.ts`)).status).toBe(404);
  await local.store.execute(command({ type: "repin", reviewId, pins }));
  expect((await app.request(`${route}?path=nested`)).status).toBe(404);
  expect((await app.request(`${route}?version=0&path=nested`)).status).toBe(
    200,
  );
});

it("reads pinned Git objects, rejects invalid evidence before saving, and retains registrations across restart", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Pinned", pins }),
  );

  await insert(review.reviewId, { type: "code_peek", source });
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;",
  });
  expect(await local.data.file(pins, "base", source.file)).toMatchObject({
    text: "export const value = 1;\n",
  });
  const diff = await local.data.changes(pins, source.file);
  expect(diff).toContain("+export const value = 2;");
  expect(diff).not.toContain("uncommitted");
  const literal = await local.data.changes(pins, "literal[1].ts");
  expect(literal).toContain("+exact filename");
  expect(literal).not.toContain("wrong pattern match");
  await expect(
    insert(review.reviewId, {
      type: "code_peek",
      source: { ...source, toLine: 4 },
    }),
  ).rejects.toThrow(/exceeds/);
  await expect(local.data.file(pins, "head", "../outside.ts")).rejects.toThrow(
    /relative/,
  );
  await expect(
    local.store.execute(
      command({
        type: "repin",
        reviewId: review.reviewId,
        pins: { ...pins, head: "HEAD" },
      }),
    ),
  ).rejects.toThrow(/resolved commit/);
  expect(local.store.read(review.reviewId).version).toBe(1);
  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database);
  expect((await local.data.register(repository)).id).toBe(pins.repositoryId);
  expect(local.store.read(review.reviewId).document).toHaveLength(1);
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
  });
});

it("refuses a committed binary file as a code reference", async () => {
  writeFileSync(path.join(repository, "binary.bin"), "text\u0000more\n");
  git("add", "binary.bin");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Binary");

  const binaryPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  await expect(
    local.data.file(binaryPins, "head", "binary.bin"),
  ).rejects.toThrow("Binary files cannot be used as code references.");
});

it("reads a committed empty file as empty text, not a missing file", async () => {
  writeFileSync(path.join(repository, "blank.ts"), "");
  git("add", "blank.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank");

  const blankPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  expect(await local.data.file(blankPins, "head", "blank.ts")).toMatchObject({
    text: "",
  });
});

it("reads a committed symlink as its target path, not the file it points at", async () => {
  const outside = path.join(directory, "outside.txt");

  writeFileSync(outside, "text outside the repository\n");
  symlinkSync(outside, path.join(repository, "link.ts"));
  git("add", "link.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Symlink");

  const linkPins = await local.data.resolvePins(
    pins.repositoryId,
    pins.head,
    "HEAD",
  );

  expect(await local.data.file(linkPins, "head", "link.ts")).toEqual({
    file: "link.ts",
    side: "head",
    commit: linkPins.head,
    text: outside,
  });
});

it("reads pinned files through one batch process per repository", async () => {
  const root = realpathSync.native(repository);

  await local.data.tree(pins, "head", "");
  recordSpawns();

  expect(await local.data.file(pins, "head", source.file)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(spawns).toEqual([["git", "-C", root, "cat-file", "--batch"]]);
  recordSpawns();

  expect(await local.data.file(pins, "head", source.file)).toMatchObject({
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  await expect(local.data.file(pins, "head", "missing.ts")).rejects.toThrow(
    "File is unavailable at the pinned commit.",
  );
  expect(spawns).toEqual([]);
});

it("answers concurrent pinned reads without spawning", async () => {
  await local.data.file(pins, "head", source.file);
  recordSpawns();

  const reads = await Promise.all(
    Array.from({ length: 23 }, (_, index) =>
      local.data.file(
        pins,
        "head",
        index % 2 === 0 ? source.file : "literal[1].ts",
      ),
    ),
  );

  expect(reads.map((read) => read.text)).toEqual(
    Array.from({ length: 23 }, (_, index) =>
      index % 2 === 0
        ? "export const value = 2;\nexport const saved = true;\n"
        : "exact filename\n",
    ),
  );
  expect(spawns).toEqual([]);
});

it("starts a new batch process for the read after an idle one ended", async () => {
  const root = realpathSync.native(repository);

  const fresh = openLocalReviewStore(path.join(directory, "idle.db"), {
    blobReaderIdleTimeoutMs: 20,
  });

  try {
    const registered = await fresh.data.register(repository);
    const freshPins = { ...pins, repositoryId: registered.id };

    await fresh.data.file(freshPins, "head", source.file);
    recordSpawns();

    // A wait, not a timing assertion: the 20 ms idle timer fired long ago.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await fresh.data.file(freshPins, "head", source.file)).toMatchObject(
      { text: "export const value = 2;\nexport const saved = true;\n" },
    );
    expect(spawns).toEqual([["git", "-C", root, "cat-file", "--batch"]]);
  } finally {
    await fresh.store.close();
    await fresh.data.close();
  }
});

it("fails a commit that is not in the repository without spawning", async () => {
  const absent = "0".repeat(40);

  await local.data.file(pins, "head", source.file);
  recordSpawns();

  await expect(
    local.data.file({ ...pins, head: absent }, "head", source.file),
  ).rejects.toThrow("File is unavailable at the pinned commit.");
  expect(spawns).toEqual([]);
});

it("rejects a path outside the repository before spawning anything", async () => {
  recordSpawns();

  for (const file of ["../outside.ts", "/etc/passwd", "nested/../../up.ts"])
    await expect(local.data.file(pins, "head", file)).rejects.toThrow(
      "Source file must be a repository-relative path.",
    );
  expect(spawns).toEqual([]);
});

it("keeps one repository detection across tree, commit and diff reads", async () => {
  await local.data.tree(pins, "head", "");
  await local.data.commits(pins);
  await local.data.changes(pins);
  await local.data.changes(pins, source.file);
  recordSpawns();

  expect(await local.data.tree(pins, "head", "")).toContainEqual({
    path: source.file,
    kind: "file",
  });
  expect(await local.data.commits(pins)).toMatchObject([
    { commit: pins.head, parentCommit: pins.base },
  ]);
  expect(await local.data.changes(pins)).toContainEqual(
    expect.objectContaining({ path: source.file, status: "modified" }),
  );
  expect(await local.data.changes(pins, source.file)).toContain(
    "+export const value = 2;",
  );
  expect(detections()).toEqual([]);
});

it("lists a pinned tree in one spawn without blocking the event loop", async () => {
  const root = realpathSync.native(repository);

  recordSpawns();

  // A sync spawn would finish inside the microtask, leaving no loop turn for setImmediate.
  let interleaved = false;
  const listing = local.data.tree(pins, "head", "");

  setImmediate(() => {
    interleaved = true;
  });

  expect(await listing).toContainEqual({ path: source.file, kind: "file" });
  expect(interleaved).toBe(true);
  expect(spawns).toEqual([
    ["git", "-C", root, "ls-tree", "-r", "-z", "--name-only", pins.head],
  ]);

  recordSpawns();
  await local.data.tree(pins, "head", "");
  expect(spawns).toEqual([]);
});

it("detects again when the repository root goes away and comes back", async () => {
  const root = realpathSync.native(repository);
  const backup = path.join(directory, "backup");

  git("clone", "--quiet", repository, backup);
  await local.data.file(pins, "head", source.file);
  recordSpawns();
  rmSync(repository, { recursive: true, force: true });

  await expect(local.data.file(pins, "head", source.file)).rejects.toThrow(
    "File is unavailable at the pinned commit.",
  );
  expect(detections()).toEqual(detectionPair(root));
  execFileSync("git", ["clone", "--quiet", backup, repository], {
    stdio: "pipe",
  });

  expect(await local.data.file(pins, "head", source.file)).toMatchObject({
    text: "export const value = 2;\nexport const saved = true;\n",
  });
  expect(detections()).toEqual([
    ...detectionPair(root),
    ...detectionPair(root),
  ]);
});

it("relists a pinned tree after the repository root comes back", async () => {
  const backup = path.join(directory, "backup");

  git("clone", "--quiet", repository, backup);
  rmSync(repository, { recursive: true, force: true });

  expect(await local.data.tree(pins, "head", "")).toEqual([]);
  execFileSync("git", ["clone", "--quiet", backup, repository], {
    stdio: "pipe",
  });

  expect(await local.data.tree(pins, "head", "")).toContainEqual({
    path: source.file,
    kind: "file",
  });
});

it("detects again after a detection that could not run", async () => {
  const root = realpathSync.native(repository);
  const fresh = openLocalReviewStore(path.join(directory, "refused.db"));

  try {
    const registered = await fresh.data.register(repository);
    const freshPins = { ...pins, repositoryId: registered.id };

    setLocalVcsCommandObserver({
      start: () => {
        throw new Error("spawn refused");
      },
    });
    await expect(
      fresh.data.file(freshPins, "head", source.file),
    ).rejects.toThrow("File is unavailable at the pinned commit.");
    recordSpawns();

    expect(await fresh.data.file(freshPins, "head", source.file)).toMatchObject(
      { text: "export const value = 2;\nexport const saved = true;\n" },
    );
    expect(detections()).toEqual(detectionPair(root));
  } finally {
    await fresh.store.close();
    await fresh.data.close();
  }
});

it("retries the commit list after a failed read instead of caching the failure", async () => {
  setLocalVcsCommandObserver({
    start: () => {
      throw new Error("spawn refused");
    },
  });
  await expect(local.data.commits(pins)).rejects.toThrow("spawn refused");
  recordSpawns();

  expect(await local.data.commits(pins)).toMatchObject([
    { commit: pins.head, parentCommit: pins.base },
  ]);
  expect(spawns.some((spawn) => spawn.includes("log"))).toBe(true);
});

it("reuses the version's commit list when a selected commit is compared", async () => {
  const root = realpathSync.native(repository);
  const [selected] = await local.data.commits(pins);
  recordSpawns();

  const compared = await local.data.comparison(pins, selected!.commit);

  expect(await local.data.file(compared, "head", source.file)).toMatchObject({
    commit: pins.head,
  });
  expect(spawns).toEqual([["git", "-C", root, "cat-file", "--batch"]]);
});

it("detects each registered repository once across interleaved reads", async () => {
  const clone = path.join(directory, "clone");

  git("clone", "--quiet", repository, clone);
  const fresh = openLocalReviewStore(path.join(directory, "interleaved.db"));

  try {
    const first = await fresh.data.register(repository);
    const second = await fresh.data.register(clone);

    recordSpawns();
    const firstPins = await fresh.data.resolvePins(first.id, "HEAD^", "HEAD");
    const secondPins = await fresh.data.resolvePins(second.id, "HEAD^", "HEAD");

    await fresh.data.file(firstPins, "head", source.file);
    await fresh.data.file(secondPins, "head", source.file);
    await fresh.data.commits(secondPins);
    await fresh.data.tree(firstPins, "head", "");
    await fresh.data.changes(secondPins);
    await fresh.data.changes(firstPins, source.file);

    expect(detections()).toEqual([
      ...detectionPair(realpathSync.native(repository)),
      ...detectionPair(realpathSync.native(clone)),
    ]);
  } finally {
    await fresh.store.close();
    await fresh.data.close();
  }
});

it("shares one detection across concurrent cold reads", async () => {
  const fresh = openLocalReviewStore(path.join(directory, "concurrent.db"));

  try {
    const registered = await fresh.data.register(repository);
    recordSpawns();

    const reads = await Promise.all(
      Array.from({ length: 10 }, () =>
        fresh.data.file(
          { ...pins, repositoryId: registered.id },
          "head",
          source.file,
        ),
      ),
    );

    expect(reads.map((read) => read.commit)).toEqual(
      Array.from({ length: 10 }, () => pins.head),
    );
    expect(detections()).toEqual(
      detectionPair(realpathSync.native(repository)),
    );
    expect(spawns).toHaveLength(3);
  } finally {
    await fresh.store.close();
    await fresh.data.close();
  }
});

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "uses the same pinned-file contract in a jj checkout",
  async () => {
    execFileSync("jj", ["git", "init", "--colocate", repository], {
      stdio: "pipe",
    });
    expect(
      await local.data.resolvePins(pins.repositoryId, pins.base, pins.head),
    ).toEqual(pins);
    expect(await local.data.quote(pins, source)).toMatchObject({
      commit: pins.head,
      text: "export const value = 2;\nexport const saved = true;",
    });
    const diff = await local.data.changes(pins, "literal[1].ts");
    expect(diff).toContain("+exact filename");
    expect(diff).not.toContain("wrong pattern match");

    const fresh = openLocalReviewStore(path.join(directory, "jj.db"));

    try {
      const registered = await fresh.data.register(repository);
      const jjPins = { ...pins, repositoryId: registered.id };

      expect(await fresh.data.tree(jjPins, "head", "")).toContainEqual({
        path: source.file,
        kind: "file",
      });
      recordSpawns();

      expect(await fresh.data.file(jjPins, "head", source.file)).toMatchObject({
        text: "export const value = 2;\nexport const saved = true;\n",
      });
      expect(detections()).toEqual([]);

      rmSync(path.join(repository, ".jj"), { recursive: true, force: true });
      expect(await fresh.data.file(jjPins, "head", source.file)).toMatchObject({
        text: "export const value = 2;\nexport const saved = true;\n",
      });
      expect(await fresh.data.tree(jjPins, "head", "")).toContainEqual({
        path: source.file,
        kind: "file",
      });
    } finally {
      await fresh.store.close();
      await fresh.data.close();
    }
  },
);

it.skipIf(spawnSync("pgrep", ["-P", String(process.pid)]).error !== undefined)(
  "closes the reader a read started after the data layer closed",
  async () => {
    recordSpawns();

    const read = local.data.file(pins, "head", source.file);

    await local.data.close();

    expect(await read).toMatchObject({
      text: "export const value = 2;\nexport const saved = true;\n",
    });
    expect(spawns.filter((spawn) => spawn.includes("cat-file"))).toHaveLength(
      1,
    );
    expect(batchProcesses()).toEqual([]);
  },
);

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "reads a conflicted jj revision as its diff materializes it",
  async () => {
    const workspace = path.join(directory, "jj-conflict");

    const jj = (...args: string[]) =>
      execFileSync("jj", args, {
        cwd: workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

    const commitId = () =>
      jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");

    execFileSync("jj", ["git", "init", workspace], { stdio: "pipe" });
    jj("config", "set", "--repo", "user.name", "Review Test");
    jj("config", "set", "--repo", "user.email", "review-test@example.invalid");
    const conflicted = path.join(workspace, "conflict.ts");

    writeFileSync(conflicted, "line1\nline2\nline3\n");
    jj("commit", "-m", "Base");
    const base = commitId();

    writeFileSync(conflicted, "left\nline2\nline3\n");
    jj("commit", "-m", "Left");
    const left = commitId();

    jj("new", base);
    writeFileSync(conflicted, "right\nline2\nline3\n");
    jj("commit", "-m", "Right");
    const right = commitId();

    jj("new", left, right, "-m", "Merge");
    jj("commit", "-m", "Merged");
    const merge = commitId();

    const registered = await local.data.register(workspace);

    const mergePins = await local.data.resolvePins(registered.id, base, merge);

    const file = await local.data.file(mergePins, "head", "conflict.ts");

    // The git tree holds one side of the conflict; jj must answer, not git.
    expect(file.text).toContain("<<<<<<< conflict");
    expect(file.text).toBe(
      jj(
        "file",
        "show",
        "-r",
        merge,
        "--ignore-working-copy",
        "--",
        'root-file:"conflict.ts"',
      ) + "\n",
    );

    const diff = await local.data.changes(mergePins, "conflict.ts");
    const hunk = /^@@ -\d+,\d+ \+\d+,(\d+) @@/m.exec(String(diff));

    expect(file.text.split("\n").slice(0, -1)).toHaveLength(Number(hunk?.[1]));

    const cleanPins = await local.data.resolvePins(registered.id, base, left);

    await local.data.file(cleanPins, "head", "conflict.ts");
    recordSpawns();

    expect(
      await local.data.file(cleanPins, "head", "conflict.ts"),
    ).toMatchObject({ text: "left\nline2\nline3\n" });
    expect(spawns).toEqual([]);
  },
);

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "reads pinned files from a non-colocated jj workspace",
  async () => {
    const workspace = path.join(directory, "jj-workspace");

    const jj = (...args: string[]) =>
      execFileSync("jj", args, {
        cwd: workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

    // jj 0.42 colocates by default.
    execFileSync(
      "jj",
      ["git", "init", "--config=git.colocate=false", workspace],
      { stdio: "pipe" },
    );
    jj("config", "set", "--repo", "user.name", "Review Test");
    jj("config", "set", "--repo", "user.email", "review-test@example.invalid");
    writeFileSync(
      path.join(workspace, source.file),
      "export const value = 1;\n",
    );
    jj("commit", "-m", "Base");
    const base = jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");
    writeFileSync(
      path.join(workspace, source.file),
      "export const value = 2;\n",
    );
    jj("commit", "-m", "Head");
    const head = jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");
    const registered = await local.data.register(workspace);

    expect(existsSync(path.join(workspace, ".git"))).toBe(false);

    const workspacePins = await local.data.resolvePins(
      registered.id,
      base,
      head,
    );

    expect(workspacePins).toEqual({
      repositoryId: registered.id,
      base,
      head,
    });
    expect(await local.data.file(workspacePins, "head", source.file)).toEqual({
      file: source.file,
      side: "head",
      commit: head,
      text: "export const value = 2;\n",
    });
    expect(await local.data.tree(workspacePins, "head", "")).toEqual([
      { path: source.file, kind: "file" },
    ]);
  },
);

it("decodes images and checks trace/map evidence before accepting components", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Resources", pins }),
  );

  const image = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "image",
    base64: (
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "red" },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  };

  await local.data.upload(image);
  await insert(review.reviewId, {
    type: "image",
    assetId: image.id,
    alt: "Red square",
  });
  await expect(
    local.data.upload({ ...image, id: randomUUID(), base64: "not an image" }),
  ).rejects.toThrow(/valid single/);

  const trace = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "trace",
    trace: {
      label: "Author",
      events: [
        { id: "answer", role: "assistant", text: "Keep the old components." },
      ],
    },
  };

  await local.data.upload(trace);
  await insert(review.reviewId, {
    type: "trace_quote",
    traceId: trace.id,
    eventId: "answer",
    text: "old components",
  });
  await expect(
    insert(review.reviewId, {
      type: "trace_quote",
      traceId: trace.id,
      eventId: "answer",
      text: "Redesign everything",
    }),
  ).rejects.toThrow(/does not match/);
  await insert(review.reviewId, {
    type: "markdown",
    markdown: `A quote: [old components](review-trace:${trace.id}#answer).`,
  });
  await expect(
    insert(review.reviewId, {
      type: "markdown",
      markdown: `[Redesign everything](review-trace:${trace.id}#answer)`,
    }),
  ).rejects.toThrow(/does not match/);

  await expect(
    local.data.upload({
      ...trace,
      trace: { ...trace.trace, label: "Different content" },
    }),
  ).rejects.toThrow(/already used/);

  const map = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          label: "App",
          containers: {
            api: {
              components: {
                example: {
                  codeElements: {
                    value: {
                      sourceRanges: [
                        { file: source.file, fromLine: 1, toLine: 2 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  await local.data.upload(map);

  const app = new Hono().route(
    "/reviews-api",
    createReviewApi(local.store, local.data),
  );

  const resolved = await app.request(
    `/reviews-api/${review.reviewId}/maps/${map.id}?version=0`,
  );

  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toMatchObject({
    side: "head",
    commit: pins.head,
    countsByElementPath: {
      "app.api.example.value": { additions: 2, deletions: 1 },
    },
  });
  await expect(
    local.data.map({ ...pins, head: pins.base }, map.id),
  ).rejects.toThrow(/does not match/);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: { app: { label: { not: "text" } } },
      },
    }),
  ).rejects.toThrow(Error);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: {
          app: {
            sourceRanges: [{ file: source.file, fromLine: 1, toLine: 2 }],
          },
        },
      },
    }),
  ).rejects.toThrow(Error);
  await insert(review.reviewId, {
    type: "software_map",
    mapVersionId: map.id,
    focusElementId: "app",
  });
  await expect(
    insert(review.reviewId, {
      type: "software_map",
      mapVersionId: map.id,
      focusElementId: "missing",
    }),
  ).rejects.toThrow(/focus/);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: {
          app: {
            containers: {
              api: {
                components: {
                  bad: {
                    codeElements: {
                      value: {
                        sourceRanges: [
                          { file: source.file, fromLine: 1, toLine: 99 },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(/exceeds/);
  await expect(
    insert(review.reviewId, {
      type: "image",
      assetId: trace.id,
      alt: "Not an image",
    }),
  ).rejects.toThrow(/component type/);
  expect(local.store.read(review.reviewId).document).toHaveLength(4);
  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database);
  expect(await local.data.upload(image)).toMatchObject({ id: image.id });
  expect(
    (await sharp(Buffer.from(local.store.resource(image.id).data)).metadata())
      .width,
  ).toBe(2);
  await local.data.validateResource(
    pins,
    local.store.read(review.reviewId).document[2]!,
  );

  const other = local.store.registerRepository(
    path.join(directory, "other-repository"),
  );

  await expect(
    local.data.validateResource(
      { ...pins, repositoryId: other.id },
      local.store.read(review.reviewId).document[0]!,
    ),
  ).rejects.toThrow(/different repository/);
});

it("exposes real source and resource operations through the authenticated desktop server", async () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "test-token",
    discoveryPath: path.join(directory, "desktop.json"),
    reviewStore: local.store,
    reviewData: local.data,
  });

  try {
    await server.listen();
    const url = server.url + "/reviews-api";

    const headers = {
      "content-type": "application/json",
      "x-review-token": "test-token",
    };

    const post = <Payload>(route: string, value: Payload) =>
      fetch(url + route, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });

    expect(
      await (await post("/repositories", { path: repository })).json(),
    ).toEqual({ id: pins.repositoryId, name: "repository" });
    expect(
      await (
        await post("/pins", {
          repositoryId: pins.repositoryId,
          base: "HEAD^",
          head: "HEAD",
        })
      ).json(),
    ).toEqual(pins);

    const review = await (
      await post("/commands", command({ type: "create", title: "HTTP", pins }))
    ).json();

    const read = async (route: string) =>
      (await fetch(url + route, { headers })).json();

    const quote = await post(`/${review.reviewId}/source`, { source });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toEqual({
      side: "head",
      file: source.file,
      fromLine: 1,
      toLine: 2,
      commit: pins.head,
      text: "export const value = 2;\nexport const saved = true;",
    });
    expect(
      await read(`/${review.reviewId}/file?side=head&file=${source.file}`),
    ).toEqual({
      file: source.file,
      side: "head",
      commit: pins.head,
      text: "export const value = 2;\nexport const saved = true;\n",
    });
    expect(await read(`/${review.reviewId}/tree`)).toEqual([
      { path: source.file, kind: "file" },
      { path: "literal1.ts", kind: "file" },
      { path: "literal[1].ts", kind: "file" },
    ]);
    expect(await read(`/${review.reviewId}/diff`)).toEqual([
      { path: source.file, status: "modified", additions: 2, deletions: 1 },
      { path: "literal1.ts", status: "added", additions: 1, deletions: 0 },
      { path: "literal[1].ts", status: "added", additions: 1, deletions: 0 },
    ]);
    expect(
      (await read(`/${review.reviewId}/diff?file=${source.file}`))
        .split("\n")
        .filter((line: string) => !line.startsWith("index ")),
    ).toEqual([
      `diff --git a/${source.file} b/${source.file}`,
      `--- a/${source.file}`,
      `+++ b/${source.file}`,
      "@@ -1 +1,2 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "+export const saved = true;",
      "",
    ]);
    expect(await read(`/${review.reviewId}/commits`)).toEqual([
      {
        commit: pins.head,
        parentCommit: pins.base,
        subject: "Head",
        author: "Review Test",
        authoredAt: expect.any(String),
        fileCount: 3,
        additions: 4,
        deletions: 1,
      },
    ]);

    const resource = {
      id: randomUUID(),
      repositoryId: pins.repositoryId,
      kind: "trace",
      trace: { label: "Test", events: [] },
    };

    expect((await post("/resources", resource)).status).toBe(200);
    expect((await fetch(url + "/resources/" + resource.id)).status).toBe(401);

    const response = await fetch(url + "/resources/" + resource.id, {
      headers,
    });

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      provenance: "client_supplied",
      events: [],
    });
    expect(
      (
        await post(`/${review.reviewId}/source`, {
          source: { ...source, toLine: 99 },
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});

it("rejects a code peek on blank lines but accepts a prose link to them", async () => {
  mkdirSync(path.join(repository, "src"));
  writeFileSync(
    path.join(repository, "src/blank.ts"),
    "export const a = 1;\n\n\n// end\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Blank lines");

  const blankPins = await local.data.resolvePins(
    pins.repositoryId,
    "HEAD^",
    "HEAD",
  );

  const blank = {
    side: "head",
    file: "src/blank.ts",
    fromLine: 2,
    toLine: 3,
  } as const;

  await expect(
    local.data.validateSource(blankPins, blank, { peek: true }),
  ).rejects.toThrow("src/blank.ts:2-3 contains only whitespace");
  await expect(
    local.data.validateSource(blankPins, blank, { peek: false }),
  ).resolves.toBeUndefined();
});

it("copies prose with the displayed version's title and immutable review identity", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Original title", pins }),
  );

  await local.store.execute(
    command({ type: "rename", reviewId, title: "Latest title" }),
  );
  const app = createReviewApi(local.store, local.data);

  const response = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: { kind: "text", quote: "First line\nSecond line" },
      title: "Selection",
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    text: `Selected text from Review: Original title\nReview ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nReview base: ${pins.base}\nReview head: ${pins.head}\nRead this version with review_get({"reviewId":"${reviewId}","version":0,"full":true}).\n\n> First line\n> Second line\n\n`,
  });
});

it("copies code from historical pins after a repin, never from working-tree contents", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const app = createReviewApi(local.store, local.data);

  const body = JSON.stringify({
    target: {
      kind: "code",
      path: source.file,
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Value",
    detail: "Selected source",
  });

  const historical = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  expect(historical.status).toBe(200);
  expect(await historical.json()).toEqual({
    text: `Selected code from Review: Code\nReview ID: ${reviewId}\nVersion: 0\nRepository ID: ${pins.repositoryId}\nReview base: ${pins.base}\nReview head: ${pins.head}\nRead this version with review_get({"reviewId":"${reviewId}","version":0,"full":true}).\n\n## Value\n\nSelected source\n\n## head: example.ts:1-1 (${pins.head})\n    export const value = 2;\n\n`,
  });

  const latest = await app.request(`/${reviewId}/copy-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  expect(latest.status).toBe(200);
  expect((await latest.json()).text).toContain("    export const value = 1;");
});

it("copies selected diff rows with rename paths without resolving an unavailable source", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Rename", pins }),
  );

  // Use selected diff rows; the new path may not exist on the base commit.
  const app = createReviewApi(local.store);

  const response = await app.request(`/${reviewId}/copy-context?version=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: {
        kind: "code",
        path: "new.md",
        side: "base",
        startLine: 4,
        endLine: 5,
      },
      title: "Renamed source",
      selectedDiff: {
        oldPath: "old.md",
        newPath: "new.md",
        oldStart: 4,
        newStart: 7,
        rows: [
          { kind: "deleted", text: "before" },
          { kind: "added", text: "```typescript" },
          { kind: "unchanged", text: "context" },
        ],
      },
    }),
  });

  expect(response.status).toBe(200);
  expect((await response.json()).text).toContain(
    "Base: a/old.md\nHead: b/new.md\nRange: -4,2 +7,2\n\n````diff\n-before\n+```typescript\n context\n````\n\n",
  );
});

it("reports invalid copy requests, unavailable versions, and missing source files as JSON errors", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Errors", pins }),
  );

  const app = createReviewApi(local.store, local.data);

  const selection = {
    target: {
      kind: "code",
      path: "missing.ts",
      side: "head",
      startLine: 1,
      endLine: 1,
    },
    title: "Missing source",
  };

  for (const [route, body, status] of [
    [`/${reviewId}/copy-context`, "{", 400],
    [`/${reviewId}/copy-context`, JSON.stringify({ title: "Invalid" }), 400],
    [`/${reviewId}/copy-context?version=nope`, JSON.stringify(selection), 400],
    [`/${reviewId}/copy-context?version=99`, JSON.stringify(selection), 404],
    ["/missing/copy-context", JSON.stringify(selection), 404],
    [`/${reviewId}/copy-context`, JSON.stringify(selection), 404],
  ] as const) {
    const response = await app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  }
});
