import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import type { Pins } from "./document";
import { createReviewApi } from "./http";
import { openLocalReviewStore } from "./local-data";

let root: string, repo: string, database: string, pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

const command = <Operation>(operation: Operation) =>
  local.store.execute({ commandId: randomUUID(), operation });

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "review-workspaces-"));
  repo = path.join(root, "repo");
  execFileSync("git", ["init", repo]);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(repo, "value.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "value.ts"), "export const value = 2;\n");
  git("commit", "-am", "head");
  database = path.join(root, "reviews.db");
  local = openLocalReviewStore(database, { workspaces: true });
  const registered = await local.data.register(repo);
  pins = await local.data.resolvePins(registered.id, base, "HEAD");
});

afterEach(async () => {
  await local.data.close();
  await local.store.close();
  rmSync(root, { recursive: true, force: true });
});

it("shares installed commits across reviews and retains historical pins until the last owner is deleted", async () => {
  const workspaces = local.data.workspaces!;
  await workspaces.configure(pins.repositoryId, {
    setup: "echo installed >> installs; echo generated > value.ts",
    teardown: "",
  });
  const first = await command({ type: "create", title: "One", pins });

  const linked = path.join(root, "linked");
  git("worktree", "add", "--detach", linked, pins.base);
  const registration = await local.data.register(linked);

  const secondPins = {
    ...pins,
    repositoryId: registration.id,
    head: pins.base,
  };

  const second = await command({
    type: "create",
    title: "Two",
    pins: secondPins,
  });

  await workspaces.idle();
  const states = workspaces.status(first.reviewId, pins);
  expect(states.map((row) => row.state)).toEqual(["ready", "ready"]);
  expect(workspaces.status(second.reviewId, secondPins)[0]!.id).toBe(
    states[0]!.id,
  );
  expect(
    readFileSync(path.join(states[0]!.directory, "installs"), "utf8"),
  ).toBe("installed\n");
  expect((await local.data.file(pins, "head", "value.ts")).text).toContain(
    "value = 2",
  );
  await command({
    type: "repin",
    reviewId: first.reviewId,
    pins: { ...pins, head: pins.base },
  });
  await workspaces.idle();
  expect(existsSync(states[1]!.directory)).toBe(true);
  await command({ type: "delete", reviewId: first.reviewId });
  await workspaces.idle();
  expect(existsSync(states[0]!.directory)).toBe(true);
  expect(existsSync(states[1]!.directory)).toBe(false);
  await command({ type: "delete", reviewId: second.reviewId });
  await workspaces.idle();
  expect(existsSync(states[0]!.directory)).toBe(false);
});

it("keeps settings local, preserves existing environments after changes, and rebuilds explicitly", async () => {
  let workspaces = local.data.workspaces!;
  await workspaces.configure(pins.repositoryId, {
    setup: "echo old > installed",
    teardown: "echo removed > ../removed",
  });
  const review = await command({ type: "create", title: "Review", pins });
  await workspaces.idle();
  const before = workspaces.status(review.reviewId, pins);
  await workspaces.configure(pins.repositoryId, {
    setup: "echo new > installed",
    teardown: "exit 1",
  });
  await local.data.close();
  await local.store.close();
  local = openLocalReviewStore(database, { workspaces: true });
  workspaces = local.data.workspaces!;
  await workspaces.idle();
  expect(workspaces.status(review.reviewId, pins).map((row) => row.id)).toEqual(
    before.map((row) => row.id),
  );
  await workspaces.rebuild(pins.repositoryId);
  await workspaces.idle();
  const after = workspaces.status(review.reviewId, pins);
  expect(after[0]!.id).not.toBe(before[0]!.id);
  expect(
    readFileSync(path.join(after[0]!.directory, "installed"), "utf8"),
  ).toBe("new\n");
  expect(existsSync(path.join(root, "workspaces", "removed"))).toBe(true);
});

it("reports missing configuration, retries failed setup, and preserves failed teardown for retry after deletion", async () => {
  const workspaces = local.data.workspaces!;

  const review = await command({
    type: "create",
    title: "Review",
    pins: { ...pins, head: pins.base },
  });

  await workspaces.idle();
  expect(workspaces.status(review.reviewId, pins)[0]!.state).toBe(
    "unconfigured",
  );
  await workspaces.configure(pins.repositoryId, {
    setup:
      "if test ! -f attempted; then touch attempted; echo setup-failed; exit 1; fi",
    teardown:
      "if test ! -f cleanup-attempted; then touch cleanup-attempted; echo cleanup-failed; exit 1; fi",
  });
  await workspaces.rebuild(pins.repositoryId);
  await workspaces.idle();
  const environment = workspaces.status(review.reviewId, pins)[0]!;
  expect(environment.state).toBe("failed");
  expect(environment.log).toContain("setup-failed");
  workspaces.retry(environment.id);
  await workspaces.idle();
  expect(workspaces.status(review.reviewId, pins)[0]!.state).toBe("ready");
  await command({ type: "delete", reviewId: review.reviewId });
  await workspaces.idle();
  expect(local.store.has(review.reviewId)).toBe(false);
  expect(workspaces.failures()[0]!.log).toContain("cleanup-failed");
  expect(existsSync(environment.directory)).toBe(true);
  workspaces.retry(environment.id);
  await workspaces.idle();
  expect(workspaces.failures()).toEqual([]);
  expect(existsSync(environment.directory)).toBe(false);
});

it("returns pinned physical source paths without reading the dirty invoking checkout", async () => {
  const review = await command({ type: "create", title: "Review", pins });
  writeFileSync(path.join(repo, "value.ts"), "dirty");
  const app = createReviewApi(local.store, local.data);

  const response = await app.request(
    `/${review.reviewId}/workspace-source?version=0&side=base&file=value.ts`,
  );

  expect(response.status).toBe(200);
  const source = await response.json();
  expect(readFileSync(source.file, "utf8")).toContain("value = 1");
  expect(readFileSync(path.join(repo, "value.ts"), "utf8")).toBe("dirty");

  const rejected = await app.request(
    `/${review.reviewId}/workspace-source?version=0&side=base&file=../outside`,
  );

  expect(rejected.ok).toBe(false);
});

it("keeps source and authoring available during setup and waits for setup before teardown", async () => {
  const workspaces = local.data.workspaces!;
  await workspaces.configure(pins.repositoryId, {
    setup:
      "while test ! -f ../release; do sleep 0.05; done; echo finished > finished",
    teardown: "test -f finished",
  });

  const review = await command({
    type: "create",
    title: "Review",
    pins: { ...pins, head: pins.base },
  });

  const source = await workspaces.source(review.reviewId, pins, "base");
  expect(source.state).toBe("preparing");
  expect(existsSync(path.join(source.directory, "value.ts"))).toBe(true);
  await command({ type: "delete", reviewId: review.reviewId });
  expect(local.store.has(review.reviewId)).toBe(false);
  expect(existsSync(source.directory)).toBe(true);
  writeFileSync(path.join(root, "workspaces", "release"), "");
  await workspaces.idle();
  expect(workspaces.failures()).toEqual([]);
  expect(existsSync(source.directory)).toBe(false);
});

it("stops setup subprocesses at shutdown and retains a retryable failure", async () => {
  const workspaces = local.data.workspaces!;
  await workspaces.configure(pins.repositoryId, {
    setup: "sleep 120",
    teardown: "",
  });

  const review = await command({
    type: "create",
    title: "Review",
    pins: { ...pins, head: pins.base },
  });

  await workspaces.source(review.reviewId, pins, "base");
  await local.data.close();
  await local.store.close();
  local = openLocalReviewStore(database, { workspaces: true });
  await local.data.workspaces!.idle();
  expect(local.data.workspaces!.status(review.reviewId, pins)[0]!.state).toBe(
    "failed",
  );
  expect(
    local.data.workspaces!.status(review.reviewId, pins)[0]!.log,
  ).toContain("shutdown");
});
