import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withFileLock } from "@dev.fast/trace-core";
import { afterEach, beforeEach, expect, it } from "vitest";

import { openReviewProfile } from "./profile.js";
import { SessionStore } from "./store.js";

let home: string;

const stores: SessionStore[] = [];

const providers = {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
};

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "review-profile-"));
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(home, { recursive: true, force: true });
});

async function fixture() {
  const initial = await openReviewProfile(home, { manageWorkspaces: false });
  await initial.data.close();
  await initial.store.close();
  const target = new SessionStore(path.join(home, "review-api.db"), providers);
  await mkdir(path.join(home, "review-server"));

  const source = new SessionStore(
    path.join(home, "review-server", "reviews.db"),
    providers,
  );

  stores.push(target, source);
  const existingRepo = target.registerRepository(path.join(home, "repo"));
  const oldRepo = source.registerRepository(path.join(home, "repo"));
  const pins = { repositoryId: oldRepo.id, base: "base", head: "head" };

  const created = await source.execute(
    command({ type: "create", title: "Headless draft", pins }),
  );

  const resourceId = randomUUID();
  source.putResource(
    resourceId,
    oldRepo.id,
    "image",
    "image/png",
    Buffer.from("retained resource"),
  );

  const edit = command({
    type: "edit",
    sessionId: created.sessionId,
    edit: {
      type: "insert",
      content: { type: "image", assetId: resourceId, alt: "Retained image" },
    },
  });

  const result = await source.execute(edit);

  return { source, target, created, existingRepo, resourceId, edit, result };
}

it("merges preview headless history and resources without changing review IDs or resurrecting deleted reviews", async () => {
  const { source, target, created, existingRepo, resourceId, edit, result } =
    await fixture();

  const before = source.read(created.sessionId);
  const profile = await openReviewProfile(home, { manageWorkspaces: false });

  try {
    expect(profile.store.read(created.sessionId)).toEqual({
      ...before,
      pins: { ...before.pins, repositoryId: existingRepo.id },
      target: { ...before.target, repositoryId: existingRepo.id },
    });
    expect(profile.store.history(created.sessionId)).toHaveLength(2);
    expect(profile.store.resource(resourceId)).toMatchObject({
      repositoryId: existingRepo.id,
    });
    expect(Buffer.from(profile.store.resource(resourceId).data)).toEqual(
      Buffer.from("retained resource"),
    );
    expect(await profile.store.execute(edit)).toEqual(result);
    expect(source.read(created.sessionId)).toEqual(before);
    await profile.store.execute(
      command({ type: "delete", sessionId: created.sessionId }),
    );
  } finally {
    await profile.data.close();
    await profile.store.close();
  }

  const reopened = await openReviewProfile(home, { manageWorkspaces: false });
  expect(reopened.store.list()).toEqual([]);
  expect(target.list()).toEqual([]);
  await reopened.data.close();
  await reopened.store.close();
});

it("refuses migration while the preview server owns its source, then succeeds after shutdown", async () => {
  const { target, created } = await fixture();

  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();

  const owner = withFileLock(
    path.join(home, "review-server", "server.lock"),
    { timeoutMs: 0, retryMs: 10, staleMs: Infinity, unownedGraceMs: 1000 },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );

  await entered.promise;

  try {
    await expect(
      openReviewProfile(home, { manageWorkspaces: false }),
    ).rejects.toThrow(/Stop the old headless server/);
    expect(target.list()).toEqual([]);
  } finally {
    release.resolve();
    await owner;
  }

  const profile = await openReviewProfile(home, { manageWorkspaces: false });
  expect(profile.store.read(created.sessionId).title).toBe("Headless draft");
  await profile.data.close();
  await profile.store.close();
});

it("rolls back the merge if a retained resource collides with different content", async () => {
  const { target, existingRepo, resourceId } = await fixture();
  target.putResource(
    resourceId,
    existingRepo.id,
    "image",
    "image/png",
    Buffer.from("different bytes"),
  );
  await expect(
    openReviewProfile(home, { manageWorkspaces: false }),
  ).rejects.toThrow(/different content/);
  expect(target.list()).toEqual([]);
  expect(Buffer.from(target.resource(resourceId).data).toString()).toBe(
    "different bytes",
  );
});
