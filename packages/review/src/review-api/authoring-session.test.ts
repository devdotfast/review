import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS } from "./activity.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base", head: "head" };

const command = <Operation>(operation: Operation, leaseId?: string) => ({
  commandId: randomUUID(),
  leaseId,
  operation,
});

let directory: string,
  database: string,
  a: ReviewStore,
  b: ReviewStore,
  reviewId: string;

let providers: ReviewProviders;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "review-session-"));
  database = path.join(directory, "reviews.db");
  providers = {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  };
  a = new ReviewStore(database, providers);
  b = new ReviewStore(database, providers);
  ({ reviewId } = await a.execute(
    command({ type: "create", title: "Initial", pins }),
  ));
});

afterEach(async () => {
  vi.useRealTimers();
  await a.close();
  await b.close();
  await rm(directory, { recursive: true, force: true });
});

it("enforces session ownership through the tool adapter while allowing reads and reader attention", async () => {
  const api = createReviewApi(a);

  const client = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => api.request(url.replace("/reviews-api", ""), init),
  );

  const leaseId = randomUUID(),
    other = randomUUID();

  const tools = await client.read<AuthoringTool[]>("/authoring");

  await callAuthoringTool(
    client,
    tools.find((tool) => tool.name === "review_activity")!,
    {
      reviewId,
      action: "begin",
      leaseId,
    },
  );
  expect(() =>
    b.activity.update(reviewId, { action: "begin", leaseId: other }),
  ).toThrow(/another session/);
  expect(
    b.activity.update(reviewId, { action: "end", leaseId: other }).workingCount,
  ).toBe(1);

  for (const operation of [
    { type: "rename", reviewId, title: "Blocked" },
    {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Blocked" },
      },
    },
    { type: "repin", reviewId, pins },
    { type: "restore", reviewId, version: 0 },
    { type: "delete", reviewId },
  ])
    await expect(b.execute(command(operation))).rejects.toMatchObject({
      status: 409,
    });
  await expect(
    b.importVersion({
      ...b.read(reviewId),
      pins: b.read(reviewId).pins!,
      title: "Blocked import",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await b.execute(command({ type: "attention", reviewId, action: "view" }));
  expect(b.read(reviewId).title).toBe("Initial");

  const input = {
    commandId: randomUUID(),
    leaseId,
    reviewId,
    edit: {
      type: "insert",
      content: { type: "markdown", markdown: "Owned edit" },
    },
  };

  await callAuthoringTool(
    client,
    tools.find((tool) => tool.name === "review_edit")!,
    input,
  );
  await callAuthoringTool(
    client,
    tools.find((tool) => tool.name === "review_edit")!,
    input,
  );
  expect(b.read(reviewId)).toMatchObject({
    version: 1,
    document: [{ markdown: "Owned edit" }],
  });
  a.activity.update(reviewId, { action: "end", leaseId });
  b.activity.update(reviewId, { action: "begin", leaseId: other });
  await b.execute(
    command({ type: "rename", reviewId, title: "Next author" }, other),
  );
  expect(a.read(reviewId).title).toBe("Next author");
});

it("keeps a lease across restart and enforces it in an independent process without blocking other reviews", async () => {
  const leaseId = randomUUID();
  a.activity.update(reviewId, { action: "begin", leaseId });
  await a.close();
  a = new ReviewStore(database, providers);
  expect(() =>
    a.activity.update(reviewId, { action: "begin", leaseId: randomUUID() }),
  ).toThrow(/another session/);

  const other = await a.execute(
    command({ type: "create", title: "Other", pins }),
  );

  const script = `
    import { ReviewStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    const store = new ReviewStore(process.argv[1], { validatePins: async()=>{}, validateSource: async()=>{}, validateResource: async()=>{} });
    try { console.log(JSON.stringify(await store.execute(JSON.parse(process.argv[2])))); }
    catch(error) { console.log(JSON.stringify({status:error.status,message:error.message})); }
    finally { await store.close(); }
  `;

  const child = async (id: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      database,
      JSON.stringify(
        command({ type: "rename", reviewId: id, title: "From child" }),
      ),
    ]);

    return JSON.parse(stdout);
  };

  expect(await child(reviewId)).toMatchObject({
    status: 409,
    message: expect.stringContaining("another session"),
  });
  expect(await child(other.reviewId)).toMatchObject({
    reviewId: other.reviewId,
    version: 1,
  });
  a.activity.update(reviewId, { action: "end", leaseId });
  expect(await child(reviewId)).toMatchObject({ reviewId, version: 1 });
});

it("keeps the lease alive through accepted writes but not rejected ones", async () => {
  vi.useFakeTimers();

  const leaseId = randomUUID(),
    focus = { description: "Drafting" };

  const expiresAt = () => b.activity.read(reviewId).expiresAt;

  const insert = (markdown: string) => ({
    type: "edit",
    reviewId,
    edit: { type: "insert", content: { type: "markdown", markdown } },
  });

  a.activity.update(reviewId, { action: "begin", leaseId, focus });

  // Each accepted write lands just before expiry and pushes it a full TTL out.
  for (const operation of [
    insert("One"),
    { type: "rename", reviewId, title: "Renamed" },
    { type: "repin", reviewId, pins },
  ]) {
    vi.advanceTimersByTime(ACTIVITY_TTL_MS - 1_000);
    await a.execute(command(operation, leaseId));
    expect(expiresAt()).toBe(Date.now() + ACTIVITY_TTL_MS);
  }

  expect(b.activity.read(reviewId).focuses).toEqual([focus]);

  // Rejected writes, with or without the lease, extend nothing.
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  const before = expiresAt();
  await expect(
    a.execute(
      command(
        { type: "edit", reviewId, edit: { type: "remove", targetId: "gone" } },
        leaseId,
      ),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    b.execute(command({ type: "rename", reviewId, title: "Intruder" })),
  ).rejects.toMatchObject({ status: 409 });
  await b.execute(command({ type: "attention", reviewId, action: "view" }));
  expect(expiresAt()).toBe(before);

  // Explicit renewal still works during a long pause without edits.
  a.activity.update(reviewId, { action: "renew", leaseId });
  expect(expiresAt()).toBe(Date.now() + ACTIVITY_TTL_MS);

  // A TTL of inactivity ends the session; the next edit is refused.
  const ended = vi.fn<(id: string) => void>();
  a.activity.subscribe(ended);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS - 1);
  expect(b.activity.read(reviewId).workingCount).toBe(1);
  vi.advanceTimersByTime(1);
  expect(b.activity.read(reviewId).workingCount).toBe(0);
  expect(ended).toHaveBeenCalledWith(reviewId);
  await expect(a.execute(command(insert("Too late"), leaseId))).rejects.toThrow(
    /ended or expired/,
  );

  // A one-off write with no session creates none.
  await b.execute(command({ type: "rename", reviewId, title: "One-off" }));
  expect(b.activity.read(reviewId)).toEqual({
    workingCount: 0,
    expiresAt: null,
  });
});

it("rejects a slow edit after its lease expires and a new author takes over", async () => {
  vi.useFakeTimers();

  const leaseId = randomUUID(),
    other = randomUUID();

  a.activity.update(reviewId, { action: "begin", leaseId });

  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();

  providers.validateSource = async () => {
    entered.resolve();
    await release.promise;
  };

  const pending = a.execute(
    command(
      {
        type: "edit",
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: {
              file: "a.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 1 },
            },
          },
        },
      },
      leaseId,
    ),
  );

  const rejected = pending.catch((error: Error) => error);
  await entered.promise;
  vi.advanceTimersByTime(ACTIVITY_TTL_MS);
  expect(() =>
    a.activity.update(reviewId, { action: "renew", leaseId }),
  ).toThrow(/expired/);
  b.activity.update(reviewId, { action: "begin", leaseId: other });
  await b.execute(
    command({ type: "rename", reviewId, title: "New owner" }, other),
  );
  release.resolve();
  expect(await rejected).toMatchObject({ status: 409 });
  expect(a.read(reviewId)).toMatchObject({
    title: "New owner",
    version: 1,
    document: [],
  });
  expect(
    a.activity.update(reviewId, { action: "end", leaseId }).workingCount,
  ).toBe(1);
});

it("rejects a stale one-off edit when another connection commits during validation", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();

  providers.validateSource = async () => {
    entered.resolve();
    await release.promise;
  };

  const pending = a.execute(
    command({
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "code_peek",
          source: {
            file: "a.ts",
            start: { side: "head", line: 1 },
            end: { side: "head", line: 1 },
          },
        },
      },
    }),
  );

  const rejected = pending.catch((error: Error) => error);
  await entered.promise;
  await b.execute(
    command({ type: "rename", reviewId, title: "Committed first" }),
  );
  release.resolve();
  expect(await rejected).toMatchObject({ status: 409 });
  expect(a.read(reviewId)).toMatchObject({
    title: "Committed first",
    version: 1,
    document: [],
  });
});
