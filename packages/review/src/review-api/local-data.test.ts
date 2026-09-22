import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setLocalVcsCommandObserver } from "@dev.fast/local-vcs";
import type { JsonValue } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectSource } from "../lens-selection";
import { createGlobalReviewServer } from "../server/desktop-server.js";
import {
  type AuthoringTool,
  ToolText,
  callAuthoringTool,
} from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
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

it("reads, resolves and retires a reference at its own pins in another repository", async () => {
  const other = path.join(directory, "other");
  mkdirSync(other);

  const otherGit = (...args: string[]) =>
    execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();

  otherGit("init", "-q");
  otherGit("config", "user.name", "Review Test");
  otherGit("config", "user.email", "review-test@example.invalid");
  writeFileSync(
    path.join(other, "lib.ts"),
    "export const other = 1;\nexport const more = 2;\n",
  );
  otherGit("add", ".");
  otherGit("-c", "commit.gpgsign=false", "commit", "-qm", "Other");
  const registered = await local.data.register(other);

  const own = {
    repositoryId: registered.id,
    head: otherGit("rev-parse", "HEAD"),
  };

  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Two repositories", pins }),
  );

  const peek = await insert(reviewId, {
    type: "code_peek",
    source: {
      file: "lib.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 2 },
      pins: own,
    },
  });

  // A branch name is not a pin, even for a reference's own pins.
  await expect(
    insert(reviewId, {
      type: "code_peek",
      source: {
        file: "lib.ts",
        start: { side: "head", line: 1 },
        end: { side: "head", line: 1 },
        pins: { ...own, head: "HEAD" },
      },
    }),
  ).rejects.toThrow(/resolved commit IDs/);

  const app = createReviewApi(local.store, local.data);
  const anchor = `repositoryId=${own.repositoryId}&head=${own.head}`;

  expect(
    await (
      await app.request(`/${reviewId}/file?side=head&file=lib.ts&${anchor}`)
    ).json(),
  ).toMatchObject({
    commit: own.head,
    text: "export const other = 1;\nexport const more = 2;\n",
  });
  expect(
    await (
      await app.request(`/${reviewId}/file?side=head&file=${source.file}`)
    ).json(),
  ).toMatchObject({ commit: pins.head });
  expect(
    await (await app.request(`/${reviewId}/tree?side=head&${anchor}`)).json(),
  ).toEqual([{ path: "lib.ts", kind: "file" }]);
  expect(
    (
      await app.request(
        `/${reviewId}/file?side=head&file=lib.ts&head=${own.head}`,
      )
    ).status,
  ).toBe(400);

  const quoted = await app.request(`/${reviewId}/source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: {
        side: "head",
        file: "lib.ts",
        fromLine: 2,
        toLine: 2,
        pins: own,
      },
    }),
  });

  expect(await quoted.json()).toMatchObject({
    commit: own.head,
    text: "export const more = 2;",
  });

  const progress = await (
    await app.request(`/${reviewId}/progress?mode=textual`)
  ).json();

  expect(
    progress.resolvedSelections[
      JSON.stringify([
        "lib.ts",
        "head",
        1,
        "head",
        2,
        `${own.repositoryId}::${own.head}`,
      ])
    ],
  ).toEqual([
    // Base-less pins compare the commit with itself, so both sides resolve.
    { file: "lib.ts", side: "base", fromLine: 1, toLine: 2 },
    { file: "lib.ts", side: "head", fromLine: 1, toLine: 2 },
  ]);
  // The other repository's file is not one of this review's changed files.
  expect(
    progress.files.map((file: { path: string }) => file.path),
  ).not.toContain("lib.ts");

  // The reference keeps its repository registered until it is gone.
  local.store.unregisterRepository(own.repositoryId);
  expect(local.store.repositoryPath(own.repositoryId)).toBe(
    realpathSync(other),
  );

  rmSync(other, { recursive: true, force: true });
  await local.store.refreshWorktrees();
  expect(local.store.read(reviewId).staleSources).toEqual([peek.targetId]);
  expect(local.store.read(reviewId).sourceUnavailable).toBeUndefined();
});

it("resolves saved branch names and fork links for the requested review version", async () => {
  git("remote", "add", "origin", "https://github.com/devdotfast/review.git");
  git("remote", "add", "fork", "git@github.com:contributor/review.git");
  git("update-ref", "refs/remotes/origin/main", pins.base);
  git("update-ref", "refs/remotes/fork/feature", pins.head);
  const reviewId = randomUUID();

  const saved = {
    reviewId,
    title: "Branch labels",
    pins,
    document: [],
    createdAt: new Date().toISOString(),
  };

  const first = await local.store.importVersion({
    ...saved,
    origin: { baseRef: "main", branch: "feature", revision: "first" },
  });

  await local.store.importVersion({
    ...saved,
    origin: { baseRef: "main", branch: "local-work", revision: "second" },
  });
  const app = createReviewApi(local.store, local.data);
  const current = await app.request(`/${reviewId}/branch-links`);
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual({
    ok: true,
    baseRef: "main",
    headRef: "local-work",
    baseUrl: "https://github.com/devdotfast/review/tree/main",
    headUrl: null,
  });

  const historical = await app.request(
    `/${reviewId}/branch-links?version=${first.version}`,
  );

  expect(historical.status).toBe(200);
  expect(await historical.json()).toEqual({
    ok: true,
    baseRef: "main",
    headRef: "feature",
    baseUrl: "https://github.com/devdotfast/review/tree/main",
    headUrl: "https://github.com/contributor/review/tree/feature",
  });
  const missing = await app.request(`/${randomUUID()}/branch-links`);
  expect(missing.status).toBe(404);
});

it("opens without waiting for acquisition and keeps diagnostic failures nonfatal", async () => {
  const created = await local.store.execute(
    command({ type: "create", title: "Immediate open", pins }),
  );

  const app = createReviewApi(local.store, local.data, async () => ({
    softwareMapEnabled: false,
  }));

  const pending = Promise.withResolvers<void>();

  const preparation = vi
    .spyOn(local.data.workspaces, "open")
    .mockReturnValue(pending.promise);

  let timer: ReturnType<typeof setTimeout>;

  try {
    const response = await Promise.race([
      app.request(`/${created.reviewId}/open`, { method: "POST" }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Open waited for preparation")),
          1000,
        );
      }),
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      softwareMapEnabled: false,
    });
  } finally {
    clearTimeout(timer!);
    pending.reject(new Error("Language environments are closed."));
    preparation.mockRestore();
  }

  await local.data.close();

  const response = await app.request(`/${created.reviewId}/open`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    environmentIssues: [
      {
        message: expect.stringContaining("Could not check language checkouts:"),
      },
    ],
  });
});

type OpenDesktop = NonNullable<Parameters<typeof createReviewApi>[2]>;

const postJson = (app: Hono, route: string, body: JsonValue) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("opens a created review in Desktop unless the author opts out", async () => {
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: true };
  });

  const shown = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Shown", pins }),
  );

  expect(shown.status).toBe(200);
  const shownReview = await shown.json();
  expect(shownReview).toMatchObject({
    opened: true,
    softwareMapEnabled: true,
  });
  expect(opened).toEqual([shownReview.reviewId]);

  const background = command({
    type: "create",
    title: "Background",
    pins,
    open: false,
  });

  const quiet = await postJson(app, "/commands", background);

  expect(quiet.status).toBe(200);
  const quietReview = await quiet.json();
  expect(quietReview).toMatchObject({ opened: false });
  expect(opened).toEqual([shownReview.reviewId]);

  // Opening is not part of the saved command: a retry may choose to show it.
  const { open: _open, ...retried } = background.operation;

  const retry = await postJson(app, "/commands", {
    ...background,
    operation: retried,
  });

  expect(await retry.json()).toMatchObject({
    reviewId: quietReview.reviewId,
    opened: true,
  });
  expect(opened).toEqual([shownReview.reviewId, quietReview.reviewId]);
});

it("opens the PR's existing review that create returns instead of a new one", async () => {
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: false };
  });

  const pullRequestUrl = "https://github.com/devdotfast/review/pull/452";

  const first = await (
    await postJson(
      app,
      "/commands",
      command({ type: "create", title: "PR", pins, pullRequestUrl }),
    )
  ).json();

  const again = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "PR again", pins, pullRequestUrl }),
  );

  expect(again.status).toBe(200);
  const body = await again.json();
  expect(body).toMatchObject({
    created: false,
    reviewId: first.reviewId,
    opened: true,
  });
  expect(body.note).toEqual(expect.any(String));
  expect(Object.keys(body).slice(0, 2)).toEqual(["created", "note"]);
  expect(opened).toEqual([first.reviewId, first.reviewId]);
});

it("does not open a created review when Desktop is not attached", async () => {
  const open = vi.fn<OpenDesktop>(async () => ({ softwareMapEnabled: false }));

  const app = createReviewApi(local.store, local.data, open, undefined, () => ({
    desktopAvailable: false,
    softwareMapEnabled: false,
  }));

  const response = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Headless", pins }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ opened: false });
  expect(open).not.toHaveBeenCalled();
  expect(
    (
      await postJson(
        app,
        "/commands",
        command({ type: "rename", reviewId: "x", title: "y", open: false }),
      )
    ).status,
  ).toBe(400);
});

it("keeps a created review when Desktop fails to open it", async () => {
  const app = createReviewApi(local.store, local.data, async () => {
    throw new Error("Desktop window closed.");
  });

  const response = await postJson(
    app,
    "/commands",
    command({ type: "create", title: "Saved anyway", pins }),
  );

  expect(response.status).toBe(200);
  const created = await response.json();
  expect(created).toMatchObject({
    opened: false,
    openError: expect.stringContaining("Desktop window closed."),
  });
  expect(local.store.read(created.reviewId).title).toBe("Saved anyway");
});

it("does not open reviews authored in batch mode", async () => {
  const open = vi.fn<OpenDesktop>(async () => ({ softwareMapEnabled: false }));

  const app = createReviewApi(
    local.store,
    local.data,
    open,
    undefined,
    () => ({ desktopAvailable: true, softwareMapEnabled: false }),
    "batch",
  );

  expect(
    (
      await postJson(
        app,
        "/commands",
        command({ type: "create", title: "Direct", pins }),
      )
    ).status,
  ).toBe(409);

  const draft = await (
    await postJson(app, "/draft-commands/begin", { title: "Batch", pins })
  ).json();

  const committed = await postJson(app, "/draft-commands/commit", {
    draftId: draft.draftId,
    commandId: randomUUID(),
  });

  expect(committed.status).toBe(200);
  expect(open).not.toHaveBeenCalled();
});

it("only reports acquisition issues to agents and clears them after recovery", async () => {
  const created = await local.store.execute(
    command({ type: "create", title: "Language availability", pins }),
  );

  const app = createReviewApi(local.store, local.data, async () => ({
    softwareMapEnabled: false,
  }));

  const open = async () => {
    const response = await app.request(`/${created.reviewId}/open`, {
      method: "POST",
    });

    expect(response.status).toBe(200);

    return response.json();
  };

  const check = async (retry = false) => {
    const response = await app.request(`/${created.reviewId}/environment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retry }),
    });

    expect(response.status).toBe(200);

    return response.json();
  };

  // No optional install command: both pinned checkouts still serve language files.
  expect(await open()).not.toHaveProperty("environmentIssues");
  expect(await check()).toEqual({ issues: [] });
  expect(
    local.data.workspaces
      .list(created.reviewId)
      .every((item) => item.state === "unconfigured"),
  ).toBe(true);

  const available = path.join(directory, "dependency-available");
  git("config", "devfast.prepare", `test -f '${available}'`);
  expect(await open()).not.toHaveProperty("environmentIssues");
  expect(await check()).toEqual({ issues: [] });
  await local.data.workspaces.idle();
  expect(
    local.data.workspaces
      .list(created.reviewId)
      .every((item) => item.state === "failed" && item.rootPath),
  ).toBe(true);
  expect(await check()).toEqual({ issues: [] });

  writeFileSync(available, "ready");
  expect(await check(true)).toEqual({ issues: [] });
  await local.data.workspaces.idle();
  expect(
    local.data.workspaces
      .list(created.reviewId)
      .every((item) => item.state === "ready"),
  ).toBe(true);

  const workspaceId = local.data.workspaces.list(created.reviewId)[0]!.id;

  const retry = async () => {
    const response = await app.request(
      `/${created.reviewId}/workspaces/${workspaceId}/retry`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);

    return response.json();
  };

  renameSync(repository, `${repository}-missing`);

  try {
    const checked = await check();
    const result = await open();
    expect(result.environmentIssues).toEqual(checked.issues);
    expect(result.environmentIssues).toEqual([
      {
        side: "head",
        message: expect.stringContaining("Pinned checkout is unavailable."),
      },
      {
        side: "base",
        message: expect.stringContaining("Pinned checkout is unavailable."),
      },
    ]);
    expect(await check()).toEqual({ issues: result.environmentIssues });

    const context = await (
      await app.request(`/${created.reviewId}/language-context?side=head`)
    ).json();

    expect(context.rootPath).toBeNull();
    expect(context.issue).toBe(result.environmentIssues[0].message);
    expect(await retry()).toMatchObject({
      id: workspaceId,
      state: "failed",
      rootPath: null,
      issue: expect.stringContaining("Pinned checkout is unavailable."),
    });
  } finally {
    renameSync(`${repository}-missing`, repository);
  }

  git("config", "--unset-all", "devfast.prepare");
  const recovered = await retry();
  expect(recovered.state).toBe("unconfigured");
  expect(recovered.rootPath).toBeTruthy();
  expect(recovered.issue).toBeUndefined();
  expect(await check()).toEqual({ issues: [] });
  expect(await open()).not.toHaveProperty("environmentIssues");
});

it("lists the full repository path and hydrates diff counts from pinned commits", async () => {
  await local.store.execute(
    command({ type: "create", title: "Home metadata", pins }),
  );
  const app = createReviewApi(local.store, local.data);
  const first = await (await app.request("/?mode=textual")).json();
  expect(first[0].repositoryPath).toBe(realpathSync(repository));
  expect(first[0].diffStats).toBeNull();
  await local.data.coverage(first[0].reviewId, pins, "textual");
  const ready = await (await app.request("/?mode=textual")).json();
  expect(ready[0].diffStats).toEqual({
    fileCount: 3,
    additions: 4,
    deletions: 1,
  });
  // Working-tree edits and attention changes cannot alter an immutable pinned diff.
  await local.store.execute(
    command({ type: "attention", reviewId: ready[0].reviewId, action: "view" }),
  );
  await local.data.coverage(first[0].reviewId, pins, "textual");
  expect(local.store.list("textual")[0]?.diffStats).toEqual(ready[0].diffStats);
});

it("uses a managed pinned worktree for language services without changing local edits", async () => {
  const created = await local.store.execute(
    command({ type: "create", title: "Local LSP", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  const before = git("status", "--porcelain");

  const response = await app.request(
    `/${created.reviewId}/language-context?version=0`,
  );

  expect(response.status).toBe(200);
  const environment = await response.json();
  expect(local.data.workspaces.list(created.reviewId)[0]?.state).toBe(
    "unconfigured",
  );
  expect(environment.rootPath).not.toBe(realpathSync(repository));
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: environment.rootPath,
      encoding: "utf8",
    }).trim(),
  ).toBe(pins.head);
  expect((await local.data.file(pins, "head", source.file)).text).toContain(
    "export const value = 2",
  );
  expect(git("status", "--porcelain")).toBe(before);
  expect(git("worktree", "list", "--porcelain")).toContain(
    environment.rootPath,
  );
  expect(
    (await app.request(`/${created.reviewId}/language-context?version=999`))
      .status,
  ).toBe(404);
  rmSync(repository, { recursive: true });
  expect(
    await (
      await app.request(`/${created.reviewId}/language-context?version=0`)
    ).json(),
  ).toMatchObject({ rootPath: null });
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

  for (const side of ["base", "head"] as const) {
    const response = await app.request(`${route}/source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 0,
        commit: firstHead,
        source: { side, file: "example.ts", fromLine: 1, toLine: 1 },
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).text).toContain(
      side === "base" ? "value = 1" : "value = 2",
    );
  }

  const file = await (
    await app.request(`${route}/file?${selected}&side=head&file=example.ts`)
  ).json();

  expect(file.text).toContain("value = 2");

  const patch = await (
    await app.request(`${route}/diff?${selected}&file=example.ts`)
  ).text();

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
  const first = local.store.read(reviewId, 0).pins!;
  const second = local.store.read(reviewId, 1).pins!;

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

  await insert(reviewId, { type: "code_peek", source: selectSource(source) });
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

  await insert(review.reviewId, {
    type: "code_peek",
    source: selectSource(source),
  });
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
      source: selectSource({ ...source, toLine: 4 }),
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
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 3;\nexport const saved = true;\n",
  );

  const live = await local.data.resolveTarget({
    kind: "worktree",
    repositoryId: pins.repositoryId,
    base: pins.base,
  });

  recordSpawns();
  expect(
    (await local.data.map(live.pins, map.id)).countsByElementPath[
      "app.api.example.value"
    ],
  ).toEqual({ additions: 2, deletions: 1 });
  const smallDiffCalls = spawns.filter((args) => args.includes("diff")).length;

  for (let index = 0; index < 20; index++)
    writeFileSync(
      path.join(repository, `extra-${index}.ts`),
      "export const extra = true;\n",
    );
  recordSpawns();
  expect(
    (await local.data.map(live.pins, map.id)).countsByElementPath[
      "app.api.example.value"
    ],
  ).toEqual({ additions: 2, deletions: 1 });
  expect(
    spawns.filter((args) => args.includes("diff")).length,
  ).toBeLessThanOrEqual(smallDiffCalls + 1);
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
      await (
        await fetch(url + `/${review.reviewId}/diff?file=${source.file}`, {
          headers,
        })
      ).text(),
    ).toBe(
      [
        `diff --git a/${source.file} b/${source.file}`,
        "@@ -1 +1,2 @@",
        "1   -export const value = 1;",
        "  1 +export const value = 2;",
        "  2 +export const saved = true;",
        "",
      ].join("\n"),
    );
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
    expect(
      (await fetch(url + "/" + review.reviewId + "/resources/" + resource.id))
        .status,
    ).toBe(401);

    const response = await fetch(
      url + "/" + review.reviewId + "/resources/" + resource.id,
      {
        headers,
      },
    );

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

it("copies a diff selection from its pinned version and selected commit, and rejects another review", async () => {
  const { reviewId } = await local.store.execute(
    command({ type: "create", title: "Code", pins }),
  );

  await local.store.execute(
    command({ type: "repin", reviewId, pins: { ...pins, head: pins.base } }),
  );
  const app = createReviewApi(local.store, local.data);

  const selection = {
    target: {
      kind: "code",
      path: source.file,
      side: "base",
      startLine: 1,
      endLine: 1,
    },
    title: "Selected parent",
    apiSource: { reviewId, version: 0, commit: pins.head },
  };

  const copy = (payload: typeof selection) =>
    app.request(`/${reviewId}/copy-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const response = await copy(selection);
  expect(response.status).toBe(200);
  const { text } = await response.json();
  expect(text).toContain("Version: 0");
  expect(text).toContain(`Selected commit: ${pins.head}`);
  expect(text).toContain(`base: example.ts:1-1 (${pins.base})`);
  expect(text).toContain("export const value = 1;");
  expect(text).not.toContain("export const value = 2;");
  expect(
    (
      await copy({
        ...selection,
        apiSource: { ...selection.apiSource, reviewId: "another-review" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await copy({
        ...selection,
        apiSource: { ...selection.apiSource, version: 999 },
      })
    ).status,
  ).toBe(404);
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

it("resolves omitted commit base once and preserves explicit parent comparisons", async () => {
  const repositoryId = pins.repositoryId;

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Single commit",
      target: { kind: "commits", repositoryId, head: "HEAD" },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect(snapshot.pins).toEqual({
    repositoryId,
    base: pins.head,
    head: pins.head,
  });
  expect(await local.data.changes(snapshot.pins!)).toEqual([]);
  expect(await local.data.file(snapshot.pins!, "head", "example.ts")).toEqual(
    await local.data.file(pins, "head", "example.ts"),
  );

  const explicit = await local.data.resolveTarget({
    kind: "commits",
    repositoryId,
    head: "HEAD",
    base: "HEAD",
  });

  expect(explicit.pins).toEqual(snapshot.pins);

  const comparison = await local.data.resolveTarget({
    kind: "commits",
    repositoryId,
    head: pins.head,
    base: pins.base,
  });

  expect(await local.data.changes(comparison.pins)).not.toEqual([]);
});

it("reads current working source across authored versions, commits and retargeting", async () => {
  const beforeIndex = git("diff", "--cached");
  const repositoryId = pins.repositoryId;
  writeFileSync(
    path.join(repository, "example.ts"),
    "export const live = 1;\n",
  );
  writeFileSync(
    path.join(repository, "untracked.ts"),
    "export const fresh = true;\n",
  );

  const request = command({
    type: "create",
    title: "Working files",
    target: { kind: "worktree", repositoryId },
  });

  const result = await local.store.execute(request);
  const original = local.store.read(result.reviewId, 0);
  expect(
    (await local.data.file(original.pins!, "head", "example.ts")).text,
  ).toContain("live = 1");
  expect(await local.data.tree(original.pins!, "head", "")).toContainEqual({
    path: "untracked.ts",
    kind: "file",
  });
  expect(await local.data.changes(original.pins!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "untracked.ts", status: "added" }),
    ]),
  );
  writeFileSync(
    path.join(repository, "example.ts"),
    "export const live = 2;\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  const current = local.store.read(result.reviewId);
  expect(
    (await local.data.file(current.pins!, "head", "example.ts")).text,
  ).toContain("live = 2");
  expect(
    (
      await local.data.file(
        local.store.read(result.reviewId, 0).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("live = 2");
  expect(local.store.history(result.reviewId)).toHaveLength(1);
  expect(await local.store.execute(request)).toEqual(result);
  expect(git("diff", "--cached")).toBe(beforeIndex);
  git("add", ".");
  git("commit", "-qm", "Save changes");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(
    await local.data.changes(local.store.read(result.reviewId).pins!),
  ).toEqual([]);
  await local.store.execute(
    command({
      type: "set_target",
      reviewId: result.reviewId,
      target: { kind: "commits", repositoryId, head: pins.head },
    }),
  );
  expect(local.store.read(result.reviewId).target?.kind).toBe("commits");
  expect(
    (await local.data.file(original.pins!, "head", "example.ts")).text,
  ).toContain("live = 2");
});

it("reads symlink text and an unborn repository without following external links or pinning", async () => {
  const root = path.join(directory, "unborn");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const repo = await local.data.register(root);
  const outside = path.join(directory, "private.ts");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, path.join(root, "external.ts"));
  writeFileSync(path.join(root, "first.ts"), "export const first = 1;\n");

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Unborn",
      target: { kind: "worktree", repositoryId: repo.id },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  expect(
    (await local.data.file(snapshot.pins!, "head", "first.ts")).text,
  ).toContain("first = 1");
  expect(
    (await local.data.file(snapshot.pins!, "head", "external.ts")).text,
  ).toBe(outside);
  expect(await local.data.changes(snapshot.pins!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "first.ts", status: "added" }),
    ]),
  );
  expect(
    execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).match(/^worktree /gm),
  ).toHaveLength(1);
});

it("keeps authored coordinates fixed as live source changes and warns only on unavailable ranges", async () => {
  writeFileSync(
    path.join(repository, "range.ts"),
    "const first = 1;\nconst second = 2;\nconst third = 3;\n",
  );

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Ranges",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  await insert(result.reviewId, {
    type: "code_peek",
    source: selectSource({
      side: "head",
      file: "range.ts",
      fromLine: 2,
      toLine: 2,
    }),
  });
  const saved = local.store.read(result.reviewId);
  writeFileSync(
    path.join(repository, "range.ts"),
    "// inserted\nconst first = 1;\nconst second = 2;\nconst third = 3;\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(local.store.read(result.reviewId).document[0]).toMatchObject({
    source: { start: { line: 2 }, end: { line: 2 } },
  });
  expect(
    local.store.read(result.reviewId, saved.version).document[0],
  ).toMatchObject({ source: { start: { line: 2 }, end: { line: 2 } } });
  writeFileSync(path.join(repository, "range.ts"), "const first = 99;\n");
  await vi.waitFor(async () => {
    await local.store.refreshWorktrees();
    expect(local.store.read(result.reviewId).staleSources).toEqual([
      saved.document[0]!.id,
    ]);
  });
});

it("reads current checkout even with an older authored version", async () => {
  const api = createReviewApi(local.store, local.data);
  writeFileSync(path.join(repository, "example.ts"), "const generation = 1;\n");

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Coherence",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "example.ts"), "const generation = 2;\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const read = async (query: string) =>
    (
      await api.request(
        `/${result.reviewId}/file?side=head&file=example.ts${query}`,
      )
    ).json();

  expect(await read("")).toMatchObject({ text: "const generation = 2;\n" });

  expect(await read("&version=0")).toMatchObject({
    text: "const generation = 2;\n",
  });
  expect(await read("")).toMatchObject({
    localPath: realpathSync(path.join(repository, "example.ts")),
  });
  expect(await read("&version=0")).toHaveProperty("localPath");
});

it("keeps multiple worktrees bound to their selected directory and survives reopening the store", async () => {
  const otherPath = path.join(directory, "other-worktree");
  git("worktree", "add", "--detach", otherPath, pins.head);
  writeFileSync(
    path.join(otherPath, "example.ts"),
    "const otherCheckout = true;\n",
  );
  const other = await local.data.register(otherPath);

  const one = await local.store.execute(
    command({
      type: "create",
      title: "First",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const two = await local.store.execute(
    command({
      type: "create",
      title: "Second",
      target: { kind: "worktree", repositoryId: other.id },
    }),
  );

  const retained = local.store.read(two.reviewId);
  await local.store.close();
  await local.data.close();
  local = openLocalReviewStore(database);
  await local.store.refreshWorktrees();
  expect(
    (
      await local.data.file(
        local.store.read(one.reviewId).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("uncommitted text");
  expect(
    (
      await local.data.file(
        local.store.read(two.reviewId).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("otherCheckout");
  expect(
    (
      await local.data.file(
        local.store.read(two.reviewId, retained.version).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("otherCheckout");
  expect(
    git("worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(2);
});

it("includes saved additions and deletions while keeping ignored and binary sources explicit", async () => {
  writeFileSync(path.join(repository, ".gitignore"), "ignored.ts\n");
  writeFileSync(path.join(repository, "ignored.ts"), "secret\n");
  writeFileSync(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(repository, "__proto__"), "legitimate filename\n");
  rmSync(path.join(repository, "example.ts"));

  const result = await local.store.execute(
    command({
      type: "create",
      title: "Files",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  const snapshot = local.store.read(result.reviewId);
  const files = await local.data.tree(snapshot.pins!, "head", "");
  expect(files).not.toContainEqual({ path: "ignored.ts", kind: "file" });
  expect(files).not.toContainEqual({ path: "example.ts", kind: "file" });
  expect(
    (await local.data.file(snapshot.pins!, "head", "__proto__")).text,
  ).toBe("legitimate filename\n");
  await expect(
    local.data.file(snapshot.pins!, "head", "binary.dat"),
  ).rejects.toThrow("Binary");
  expect(await local.data.changes(snapshot.pins!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "example.ts", status: "deleted" }),
      expect.objectContaining({ path: "binary.dat", status: "added" }),
    ]),
  );
});

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "reads unsnapshotted jj working files without changing the operation or Git index",
  async () => {
    const root = path.join(directory, "jj-working");
    execFileSync("jj", ["git", "init", root]);

    const jj = (...args: string[]) =>
      execFileSync("jj", ["-R", root, ...args, "--ignore-working-copy"], {
        encoding: "utf8",
      }).trim();

    const repo = await local.data.register(root);
    const base = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    const operation = jj("op", "log", "--no-graph", "--limit", "1", "-T", "id");
    writeFileSync(
      path.join(root, "new.ts"),
      "export const unsnapshotted = 1;\n",
    );

    const result = await local.store.execute(
      command({
        type: "create",
        title: "jj working",
        target: { kind: "worktree", repositoryId: repo.id, base },
      }),
    );

    expect(
      (
        await local.data.file(
          local.store.read(result.reviewId).pins!,
          "head",
          "new.ts",
        )
      ).text,
    ).toContain("unsnapshotted");
    expect(
      await local.data.changes(local.store.read(result.reviewId).pins!),
    ).toEqual([expect.objectContaining({ path: "new.ts", status: "added" })]);
    expect(jj("op", "log", "--no-graph", "--limit", "1", "-T", "id")).toBe(
      operation,
    );
  },
);

it("retargets a live review without losing authored content or component IDs", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
      title: "Retarget",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  await insert(created.reviewId, {
    type: "code_peek",
    source: selectSource({
      side: "head",
      file: "example.ts",
      fromLine: 1,
      toLine: 1,
    }),
  });
  const before = local.store.read(created.reviewId);

  const result = await local.store.execute(
    command({
      type: "set_target",
      reviewId: created.reviewId,
      target: {
        kind: "commits",
        repositoryId: pins.repositoryId,
        head: pins.head,
      },
    }),
  );

  expect(local.store.read(created.reviewId).document).toEqual(before.document);
  expect(result.warnings?.length).toBeGreaterThan(0);
  expect(
    (
      await local.data.file(
        local.store.read(created.reviewId, before.version).pins!,
        "head",
        "example.ts",
      )
    ).text,
  ).toContain("uncommitted text");
});

it("worktree language contexts never prepare or create checkouts, including historical/base requests", async () => {
  git("config", "devfast.prepare", "echo unexpected > prepared");

  const created = await local.store.execute(
    command({
      type: "create",
      title: "Live LSP",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  const app = createReviewApi(local.store, local.data, async () => ({
    softwareMapEnabled: false,
  }));

  const before = git("worktree", "list", "--porcelain");
  expect(
    (await app.request(`/${created.reviewId}/open`, { method: "POST" })).status,
  ).toBe(200);

  for (const side of ["base", "head"]) {
    const response = await app.request(
      `/${created.reviewId}/language-context?version=0&side=${side}`,
    );

    expect(await response.json()).toMatchObject({
      rootPath: realpathSync(repository),
      identity: expect.any(String),
    });
  }

  await local.data.workspaces.idle();
  expect(local.data.workspaces.list(created.reviewId)).toEqual([]);
  expect(git("worktree", "list", "--porcelain")).toBe(before);
  expect(existsSync(path.join(repository, "prepared"))).toBe(false);
});

it.each(["repin", "set_target"] as const)(
  "recovers persisted stale source and clears flags on %s",
  async (operation) => {
    const original = "const first = 1;\nconst second = 2;\n";
    writeFileSync(path.join(repository, "recover.ts"), original);

    const created = await local.store.execute(
      command({
        type: "create",
        title: "Recovery",
        target: {
          kind: "worktree",
          repositoryId: pins.repositoryId,
          base: pins.head,
        },
      }),
    );

    await insert(created.reviewId, {
      type: "code_peek",
      source: selectSource({
        side: "head",
        file: "recover.ts",
        fromLine: 2,
        toLine: 2,
      }),
    });
    writeFileSync(path.join(repository, "recover.ts"), "const first = 99;\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renamed = await local.store.execute(
      command({
        type: "rename",
        reviewId: created.reviewId,
        title: "Still editable",
      }),
    );

    expect(renamed.warnings?.length).toBeGreaterThan(0);
    expect(local.store.read(created.reviewId).staleSources).toHaveLength(1);
    await expect(
      insert(created.reviewId, {
        type: "code_peek",
        source: selectSource({
          side: "head",
          file: "recover.ts",
          fromLine: 99,
          toLine: 99,
        }),
      }),
    ).rejects.toThrow("exceeds the pinned file");
    writeFileSync(path.join(repository, "recover.ts"), original);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await local.store.refreshWorktrees();
    expect(local.store.read(created.reviewId).staleSources).toEqual([]);
    expect(local.store.read(created.reviewId).document[0]).toMatchObject({
      source: { start: { line: 2 }, end: { line: 2 } },
    });
    expect(
      local.store.read(created.reviewId, renamed.version).staleSources,
    ).toHaveLength(1);
    await local.store.execute(
      command({
        type: "restore",
        reviewId: created.reviewId,
        version: renamed.version,
      }),
    );
    expect(local.store.read(created.reviewId).staleSources).toHaveLength(1);
    await local.store.execute(
      command(
        operation === "repin"
          ? { type: "repin", reviewId: created.reviewId, pins }
          : {
              type: "set_target",
              reviewId: created.reviewId,
              target: { kind: "commits", ...pins },
            },
      ),
    );
    expect(local.store.read(created.reviewId).staleSources).toEqual([]);
  },
);

it("leaves authored Markdown destinations unchanged when source lines move", async () => {
  const original =
    Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") +
    "\n";

  writeFileSync(path.join(repository, "links.ts"), original);

  const created = await local.store.execute(
    command({
      type: "create",
      title: "Links",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.head,
      },
    }),
  );

  await insert(created.reviewId, {
    type: "markdown",
    markdown:
      "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
  });
  writeFileSync(path.join(repository, "links.ts"), "inserted\n" + original);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await local.store.refreshWorktrees();
  expect(local.store.read(created.reviewId).document[0]).toMatchObject({
    markdown:
      "[one](review-source:head/links.ts#L1) [ten](review-source:head/links.ts#L10-L20)",
  });
});

it("does not report clean tracked symlinks and submodules as modified", async () => {
  symlinkSync("example.ts", path.join(repository, "tracked-link.ts"));
  const modulePath = path.join(directory, "module");
  mkdirSync(modulePath);
  execFileSync("git", ["init", "-q", modulePath]);
  writeFileSync(path.join(modulePath, "file.txt"), "module\n");
  execFileSync("git", ["-C", modulePath, "add", "."]);
  execFileSync("git", [
    "-C",
    modulePath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "Initial",
  ]);
  git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    modulePath,
    "module",
  );
  git("add", ".");
  git("commit", "-qm", "Link and module");
  const head = git("rev-parse", "HEAD");

  const created = await local.store.execute(
    command({
      type: "create",
      title: "Clean modes",
      target: { kind: "worktree", repositoryId: pins.repositoryId, base: head },
    }),
  );

  expect(
    await local.data.changes(local.store.read(created.reviewId).pins!),
  ).toEqual([]);
  expect(
    (
      await local.data.file(
        local.store.read(created.reviewId).pins!,
        "head",
        "tracked-link.ts",
      )
    ).text,
  ).toBe("example.ts");
  const snapshot = local.store.read(created.reviewId);
  await expect(
    local.data.file(snapshot.pins!, "head", "module"),
  ).rejects.toThrow("not a regular file");

  const response = await createReviewApi(local.store, local.data).request(
    `/${created.reviewId}/file?side=head&file=module`,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Source is not a regular file.",
  });
});

it("continues capturing after watchers fail and stop emitting changes", async () => {
  await local.data.close();
  await local.store.close();
  const watchers: FSWatcher[] = [];
  local = openLocalReviewStore(database, {
    watch: ((...args: Parameters<typeof watch>) => {
      const watcher = watch(...args);
      watchers.push(watcher);

      return watcher;
    }) as typeof watch,
  });

  const created = await local.store.execute(
    command({
      type: "create",
      title: "Watcher recovery",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.head,
      },
    }),
  );

  for (const watcher of watchers)
    watcher.emit(
      "error",
      Object.assign(new Error("Watch limit"), { code: "ENOSPC" }),
    );

  for (const value of ["first change\n", "second change\n"]) {
    writeFileSync(path.join(repository, "example.ts"), value);
    await local.store.refreshWorktrees();
    expect(
      (
        await local.data.file(
          local.store.read(created.reviewId).pins!,
          "head",
          "example.ts",
        )
      ).text,
    ).toBe(value);
  }
});

it("keeps live language identity across edits but replaces it with a checkout at the same path", async () => {
  const created = await local.store.execute(
    command({
      type: "create",
      title: "Environment identity",
      target: {
        kind: "worktree",
        repositoryId: pins.repositoryId,
        base: pins.base,
      },
    }),
  );

  const saved = local.store.read(created.reviewId, created.version);
  const before = await local.data.languageEnvironment(saved, "head");
  const retained = await local.data.file(saved.pins!, "head", source.file);
  writeFileSync(path.join(repository, "identity.ts"), "const changed = true;");
  expect(await local.data.languageEnvironment(saved, "head")).toEqual(before);
  const moved = `${repository}-previous`;
  renameSync(repository, moved);

  try {
    expect(
      (await local.data.languageEnvironment(saved, "head")).rootPath,
    ).toBeNull();
    mkdirSync(repository);
    execFileSync("git", ["clone", "--quiet", moved, repository]);
    const replacement = await local.data.languageEnvironment(saved, "head");
    expect(replacement.rootPath).toBe(before.rootPath);
    expect(replacement.identity).not.toBe(before.identity);
    expect(local.data.workspaces.list(created.reviewId)).toEqual([]);
    expect(
      (await local.data.file(saved.pins!, "head", source.file)).text,
    ).not.toEqual(retained.text);
  } finally {
    rmSync(moved, { recursive: true, force: true });
  }
});

it("marks a commit-pinned review unavailable while its repository is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Moved repository", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  const moved = `${repository}-moved`;
  renameSync(repository, moved);

  const degraded = await app.request(`/${review.reviewId}?full=true`);

  expect(degraded.status).toBe(200);
  expect(await degraded.json()).toMatchObject({
    title: "Moved repository",
    sourceUnavailable: true,
  });
  // The canvas follows the watch stream, which reads the store, not ?full=true.
  await local.store.refreshWorktrees();
  expect(local.store.read(review.reviewId).sourceUnavailable).toBe(true);
  // A pinned version bypasses both the refresh loop and the live overlay.
  expect(
    await (await app.request(`/${review.reviewId}?full=true&version=0`)).json(),
  ).toMatchObject({ sourceUnavailable: true });

  renameSync(moved, repository);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).sourceUnavailable).toBeUndefined();
});

it("never stores the unavailable flag on a version authored while degraded", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Edited while gone", pins }),
  );

  const moved = `${repository}-moved`;
  renameSync(repository, moved);
  await local.store.refreshWorktrees();

  const edited = await insert(review.reviewId, {
    type: "markdown",
    markdown: "Authored with no checkout.",
  });

  renameSync(moved, repository);
  await local.store.refreshWorktrees();

  expect(
    local.store.read(review.reviewId, edited.version).sourceUnavailable,
  ).toBeUndefined();
});

it("answers a source read with 404 while the checkout is gone", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Moved repository", pins }),
  );

  const app = createReviewApi(local.store, local.data);
  renameSync(repository, `${repository}-moved`);

  const response = await app.request(`/${review.reviewId}/commits`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "The selected local checkout is unavailable.",
  });
  // Direct callers skip the snapshot check and reach the checkout itself.
  await expect(local.data.commits(pins)).rejects.toThrow(
    "The selected local checkout is unavailable.",
  );
});

it("marks a worktree review unavailable while its checkout is gone", async () => {
  const review = await local.store.execute(
    command({
      type: "create",
      title: "Moved worktree",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  renameSync(repository, `${repository}-moved`);
  await local.store.refreshWorktrees();

  expect(local.store.read(review.reviewId).sourceUnavailable).toBe(true);
});

it("validates grouped source ranges with one read per pinned file", async () => {
  const read = vi.spyOn(local.data, "file");

  try {
    await local.data.validateSources(pins, [
      source,
      { ...source, fromLine: 2 },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      local.data.validateSources(pins, [source, { ...source, toLine: 100000 }]),
    ).rejects.toThrow("exceeds the pinned file");
    await expect(
      local.data.validateSources(pins, [{ ...source, file: "missing.ts" }]),
    ).rejects.toThrow("unavailable");
    read.mockClear();
    await local.data.validateSources(pins, [
      source,
      { ...source, side: "base", toLine: 1 },
    ]);
    expect(read).toHaveBeenCalledTimes(pins.base === pins.head ? 1 : 2);
  } finally {
    read.mockRestore();
  }
});

describe("review_diff", () => {
  const exampleLines = (changed: number) =>
    Array.from({ length: 12 }, (_, index) =>
      index + 1 === changed ? "changed line" : `line ${index + 1}`,
    ).join("\n") + "\n";

  let reviewId: string;
  let call: (input: Record<string, JsonValue>) => Promise<JsonValue>;

  beforeEach(async () => {
    writeFileSync(path.join(repository, source.file), exampleLines(0));
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Twelve lines");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(repository, source.file), exampleLines(6));
    mkdirSync(path.join(repository, "dir"));
    git("mv", "literal1.ts", "dir/moved.ts");
    writeFileSync(
      path.join(repository, "dir/big.ts"),
      Array.from({ length: 40 }, (_, index) => `big ${index}`).join("\n") +
        "\n",
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Change");

    const diffPins = await local.data.resolvePins(
      pins.repositoryId,
      base,
      "HEAD",
    );

    ({ reviewId } = await local.store.execute(
      command({ type: "create", title: "Diff", pins: diffPins }),
    ));

    const app = createReviewApi(local.store, local.data);

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => app.request(url.replace("/reviews-api", ""), init),
    );

    const tools = await client.read<AuthoringTool[]>("/authoring");
    const tool = tools.find((item) => item.name === "review_diff")!;

    call = async (input) => {
      const result = await callAuthoringTool(client, tool, {
        reviewId,
        ...input,
      });

      return result instanceof ToolText ? result.text : result;
    };
  });

  it("lists every changed file, or those a pathspec names", async () => {
    expect(await call({})).toEqual([
      { path: "dir/big.ts", status: "added", additions: 40, deletions: 0 },
      {
        path: "dir/moved.ts",
        previousPath: "literal1.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      { path: "example.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(await call({ paths: ["example.ts"] })).toEqual([
      { path: "example.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(
      (
        (await call({ paths: ["dir/", "literal1.ts"] })) as { path: string }[]
      ).map((file) => file.path),
    ).toEqual(["dir/big.ts", "dir/moved.ts"]);
  });

  it("returns every patch with base and head line numbers", async () => {
    const text = (await call({ format: "patch" })) as string;

    expect(text).toContain("diff --git a/dir/big.ts b/dir/big.ts\n");
    expect(text).toContain("   40 +big 39\n");
    expect(text).toContain(
      "diff --git a/literal1.ts b/dir/moved.ts\nsimilarity index 100%\nrename from literal1.ts\nrename to dir/moved.ts\n",
    );
    expect(text).toContain(
      [
        "diff --git a/example.ts b/example.ts",
        "@@ -3,7 +3,7 @@ line 2",
        " 3  3  line 3",
        " 4  4  line 4",
        " 5  5  line 5",
        " 6    -line 6",
        "    6 +changed line",
        " 7  7  line 7",
        " 8  8  line 8",
        " 9  9  line 9",
        "",
      ].join("\n"),
    );
  });

  it("returns only the patches a pathspec names, both sides of a rename included", async () => {
    const text = (await call({
      format: "patch",
      paths: ["dir/moved.ts", "missing.ts"],
    })) as string;

    expect(text).toContain("rename from literal1.ts\nrename to dir/moved.ts");
    expect(text).not.toContain("example.ts");
    expect(text).not.toContain("big.ts");
    expect(text).toContain('[No changes match paths:["missing.ts"].]');
  });

  it("reads a legacy file as its numbered patch and rejects mixing it with paths or format", async () => {
    expect(await call({ file: "example.ts" })).toBe(
      await call({ format: "patch", paths: ["example.ts"] }),
    );
    await expect(
      call({ file: "example.ts", paths: ["example.ts"] }),
    ).rejects.toThrow(/file cannot be combined with paths or format/);
    await expect(call({ file: "example.ts", format: "patch" })).rejects.toThrow(
      /file cannot be combined/,
    );
  });

  it("lists patches past maxBytes with a paths hint", async () => {
    const text = (await call({ format: "patch", maxBytes: 400 })) as string;

    expect(text).toContain("diff --git a/dir/big.ts");
    expect(text).toContain("[dir/big.ts is cut at the 400-byte budget after");
    expect(text).toMatch(
      /\[2 more files over the 400-byte budget: dir\/moved\.ts, example\.ts \(\+1 -1\)\. Fetch them with paths:\["dir\/moved\.ts","example\.ts"\], format:"patch"\.\]\n$/,
    );

    const next = (await call({
      format: "patch",
      paths: ["dir/moved.ts", "example.ts"],
      maxBytes: 400,
    })) as string;

    expect(next).toContain("rename to dir/moved.ts");
    expect(next).toContain("diff --git a/example.ts b/example.ts");
    expect(next).not.toContain("budget");
  });

  it("applies context lines around each change", async () => {
    expect(
      await call({ format: "patch", paths: ["example.ts"], context: 0 }),
    ).toBe(
      [
        "diff --git a/example.ts b/example.ts",
        "@@ -6 +6 @@ line 5",
        "6   -line 6",
        "  6 +changed line",
        "",
      ].join("\n"),
    );
  });
});

it("patches working files of a worktree review, untracked files included", async () => {
  const api = createReviewApi(local.store, local.data);

  const { reviewId } = await local.store.execute(
    command({
      type: "create",
      title: "Working",
      target: { kind: "worktree", repositoryId: pins.repositoryId },
    }),
  );

  writeFileSync(path.join(repository, "fresh.ts"), "fresh\n");

  const list = await (await api.request(`/${reviewId}/diff`)).json();

  expect(list).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "fresh.ts", status: "added" }),
    ]),
  );

  const response = await api.request(
    `/${reviewId}/diff?format=patch&paths=fresh.ts&paths=${source.file}`,
  );

  expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  const text = await response.text();

  expect(text).toContain("diff --git a/fresh.ts b/fresh.ts\nnew file mode");
  expect(text).toContain("  1 +fresh\n");
  expect(text).toContain("+uncommitted text must never appear");
  expect(text).not.toContain("literal");
});
