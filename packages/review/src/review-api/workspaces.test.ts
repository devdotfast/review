import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";
import type { z } from "zod";

import { runPrepareCommand } from "../review-prepare.js";
import type { Pins } from "./document.js";
import { createReviewApi } from "./http.js";
import { openLocalReviewStore } from "./local-data.js";
import type { commandSchema } from "./store.js";

let directory: string,
  repository: string,
  database: string,
  reviewId: string,
  pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

type Operation = z.infer<typeof commandSchema>["operation"];

const command = (operation: Operation) =>
  local.store.execute({ commandId: randomUUID(), operation });

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "pinned-language-"));
  repository = path.join(directory, "repo");
  execFileSync("git", ["init", "-q", repository]);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(
    path.join(repository, "value.ts"),
    "export const value = 'base';\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(
    path.join(repository, "value.ts"),
    "export const value = 42;\n",
  );
  git("commit", "-am", "head", "--no-gpg-sign");
  const head = git("rev-parse", "HEAD");
  database = path.join(directory, "reviews.db");
  local = openLocalReviewStore(database);
  const registered = await local.data.register(repository);
  pins = { repositoryId: registered.id, base, head };
  reviewId = (await command({ type: "create", title: "Pinned", pins }))
    .reviewId;
});

afterEach(async () => {
  await local.data.close();
  await local.store.close();
  rmSync(directory, { recursive: true, force: true });
});

it("prepares each side once in order, reuses on restart, and invalidates changed commands", async () => {
  git("config", "devfast.prepare", "printf first > prepared");
  git("config", "--add", "devfast.prepare", "printf second >> prepared");
  writeFileSync(path.join(repository, "value.ts"), "dirty invoking checkout\n");

  const contexts = await Promise.all(
    Array.from({ length: 5 }, () =>
      local.data.workspaces.source(reviewId, pins, "head"),
    ),
  );

  await local.data.workspaces.open(reviewId, pins);
  await local.data.workspaces.idle();
  const head = await local.data.workspaces.source(reviewId, pins, "head");
  const base = await local.data.workspaces.source(reviewId, pins, "base");
  expect(contexts.every((context) => context.id === head.id)).toBe(true);
  expect(head.rootPath).not.toBe(base.rootPath);
  expect(readFileSync(path.join(head.rootPath!, "prepared"), "utf8")).toBe(
    "firstsecond",
  );
  expect(readFileSync(path.join(base.rootPath!, "value.ts"), "utf8")).toContain(
    "base",
  );
  expect(readFileSync(path.join(head.rootPath!, "value.ts"), "utf8")).toContain(
    "42",
  );
  expect(readFileSync(path.join(repository, "value.ts"), "utf8")).toBe(
    "dirty invoking checkout\n",
  );
  await local.data.close();
  await local.store.close();
  local = openLocalReviewStore(database);
  const restarted = await local.data.workspaces.source(reviewId, pins, "head");
  expect(restarted.state).toBe("ready");
  expect(restarted.generation).not.toBe(head.generation);
  expect(readFileSync(path.join(head.rootPath!, "prepared"), "utf8")).toBe(
    "firstsecond",
  );
  git(
    "config",
    "--replace-all",
    "devfast.prepare",
    "printf changed > prepared",
  );
  expect(
    (await local.data.workspaces.source(reviewId, pins, "head")).state,
  ).toBe("preparing");
  await local.data.workspaces.idle();
  expect(readFileSync(path.join(head.rootPath!, "prepared"), "utf8")).toBe(
    "changed",
  );
});

it("retains failure without retry loops, retries at the original side, and recreates missing checkouts", async () => {
  git("config", "devfast.prepare", "echo failure; exit 7");
  await local.data.workspaces.source(reviewId, pins, "base");
  await local.data.workspaces.idle();
  const failed = await local.data.workspaces.source(reviewId, pins, "base");
  expect(failed.state).toBe("failed");
  expect(failed.log).toContain("failure");
  expect(failed.issue).toBeUndefined();
  expect(existsSync(`${failed.rootPath}.prepared`)).toBe(false);
  expect(
    (await local.data.workspaces.source(reviewId, pins, "base")).generation,
  ).toBe(failed.generation);
  git("config", "devfast.prepare", "echo installed > dependency");
  await local.data.workspaces.retry(reviewId, failed.id);
  await local.data.workspaces.idle();
  const ready = await local.data.workspaces.source(reviewId, pins, "base");
  expect(ready.rootPath).toBe(failed.rootPath);
  expect(ready.state).toBe("ready");
  rmSync(ready.rootPath!, { recursive: true });
  await local.data.workspaces.source(reviewId, pins, "base");
  await local.data.workspaces.idle();
  expect(
    readFileSync(path.join(ready.rootPath!, "dependency"), "utf8"),
  ).toContain("installed");
});

it("keeps historical and equal-side environments until review deletion and leaves user worktrees alone", async () => {
  await local.data.workspaces.open(reviewId, { ...pins, base: pins.head });
  expect(local.data.workspaces.list(reviewId)).toHaveLength(1);
  const old = await local.data.workspaces.source(reviewId, pins, "base");
  await command({
    type: "repin",
    reviewId,
    pins: { ...pins, base: pins.head },
  });
  expect(existsSync(old.rootPath!)).toBe(true);
  await command({ type: "delete", reviewId });
  await local.data.workspaces.idle();
  expect(existsSync(old.rootPath!)).toBe(false);
  expect(
    git("worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(1);
});

it("does not block source reads during preparation and interrupts commands on shutdown", async () => {
  git("config", "devfast.prepare", "echo started; sleep 60");
  const context = await local.data.workspaces.source(reviewId, pins, "head");
  expect(context.state).toBe("preparing");
  expect((await local.data.file(pins, "head", "value.ts")).text).toContain(
    "42",
  );
  await local.data.close();
  await local.store.close();
  local = openLocalReviewStore(database);
  expect(local.data.workspaces.list(reviewId)[0]?.state).toBe("failed");
  expect(existsSync(`${context.rootPath}.prepared`)).toBe(false);
});

it("bounds preparation runtime and captures diagnostics", async () => {
  await expect(
    runPrepareCommand(
      "echo waiting; sleep 60",
      repository,
      () => {},
      new AbortController().signal,
      100,
    ),
  ).rejects.toThrow("timed out");
});

it("persists failed cleanup and retries it without deleting an unrelated checkout", async () => {
  const environment = await local.data.workspaces.source(
    reviewId,
    pins,
    "head",
  );

  git("worktree", "lock", environment.rootPath!);
  await command({ type: "delete", reviewId });
  await local.data.workspaces.idle();
  const app = createReviewApi(local.store, local.data);

  const cleanup = async (workspaceId?: string) => {
    const response = await app.request("/workspace-cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status).toBe(200);

    return response.json();
  };

  expect((await cleanup()).failures).toMatchObject([
    { id: environment.id, state: "cleanup-failed" },
  ]);
  expect(existsSync(environment.rootPath!)).toBe(true);
  git("worktree", "unlock", environment.rootPath!);
  expect((await cleanup(environment.id)).failures).toEqual([]);
  expect(existsSync(environment.rootPath!)).toBe(false);
  expect(existsSync(path.join(repository, "value.ts"))).toBe(true);
});

it("reports a missing repository before first acquisition and recovers after it returns", async () => {
  renameSync(repository, `${repository}-missing`);
  const missing = await local.data.workspaces.source(reviewId, pins, "head");
  expect(missing.state).toBe("failed");
  expect(missing.rootPath).toBeNull();
  expect(missing.issue).toBe(missing.log);
  expect(missing.log).toContain("Restore the registered checkout");
  renameSync(`${repository}-missing`, repository);
  const restored = await local.data.workspaces.source(reviewId, pins, "head");
  expect(restored.state).toBe("unconfigured");
  expect(restored.issue).toBeUndefined();
  expect(restored.rootPath).not.toBe(repository);
  expect(
    readFileSync(path.join(restored.rootPath!, "value.ts"), "utf8"),
  ).toContain("42");
});
