import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS, SessionActivity } from "./activity.js";
import { SessionApiClient } from "./client.js";
import { createSessionApi } from "./http.js";
import { SessionStore } from "./store.js";

const databases: DatabaseSync[] = [];

const newActivity = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);

  return new SessionActivity(db);
};

afterEach(() => {
  vi.useRealTimers();

  for (const db of databases.splice(0)) db.close();
});

it("renews reported work, expires abandoned work, and does not end another author's activity", () => {
  vi.useFakeTimers();
  const activity = newActivity();
  const notify = vi.fn<Parameters<SessionActivity["subscribe"]>[0]>();
  activity.subscribe(notify);

  const a = randomUUID(),
    b = randomUUID();

  const update = (leaseId: string, action: "begin" | "renew" | "end") =>
    activity.update("review", { leaseId, action });

  expect(update(a, "begin").workingCount).toBe(1);
  expect(update(a, "begin").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  update(a, "renew");
  expect(() => update(b, "begin")).toThrow(/another session/);
  expect(update(b, "end").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  expect(activity.read("review").workingCount).toBe(1);
  expect(update(a, "end").workingCount).toBe(0);
  expect(update(a, "end").workingCount).toBe(0);
  update(b, "begin");
  vi.advanceTimersByTime(ACTIVITY_TTL_MS);
  expect(activity.read("review")).toEqual({ workingCount: 0, expiresAt: null });
  expect(notify).toHaveBeenLastCalledWith("review");
  expect(() => update(b, "renew")).toThrow(/expired/);
  activity.update("another", { leaseId: randomUUID(), action: "begin" });
  expect(activity.read("review").workingCount).toBe(0);
  activity.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("streams activity separately from document versions and closes the stream on deletion", async () => {
  const store = new SessionStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const api = createSessionApi(store);

  const client = new SessionApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => api.request(url.replace("/sessions-api", ""), init),
  );

  const command = <Operation>(operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation });

  const { sessionId } = await command({
    type: "create",
    title: "Activity",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  });

  const changed = vi.fn<Parameters<SessionStore["subscribe"]>[0]>();
  store.subscribe(changed);
  const abort = new AbortController();
  const stream = client.watch(sessionId, abort.signal);

  try {
    expect((await stream.next()).value).toMatchObject({
      activity: { workingCount: 0 },
    });

    const input = {
      action: "begin",
      leaseId: randomUUID(),
      focus: { description: "Drafting outline" },
    };

    await client.post(`/${sessionId}/activity`, input);
    expect((await stream.next()).value).toMatchObject({
      activity: { workingCount: 1, focuses: [input.focus] },
    });
    expect(changed).not.toHaveBeenCalled();
    expect(store.history(sessionId)).toHaveLength(1);
    const reconnect = client.watch(sessionId, abort.signal);
    expect((await reconnect.next()).value).toMatchObject({
      activity: { workingCount: 1, focuses: [input.focus] },
    });
    await reconnect.return(undefined);
    await store.execute({
      commandId: randomUUID(),
      leaseId: input.leaseId,
      operation: { type: "delete", sessionId },
    });
    // A reader may already have buffered a pre-deletion snapshot.
    await expect(async () => {
      for await (const _snapshot of stream) {
      }
    }).rejects.toThrow(Error);
    await expect(client.post(`/${sessionId}/activity`, input)).rejects.toThrow(
      /not found/i,
    );
    expect(store.activity.read(sessionId).workingCount).toBe(0);
  } finally {
    abort.abort();
    await store.close();
  }
});

it("retains, changes and clears the owner's focus until its lease expires", () => {
  vi.useFakeTimers();
  const activity = newActivity();
  const leaseId = randomUUID();
  const other = randomUUID();
  const focus = { description: "Adding evidence", targetId: "section-1" };
  activity.update("review", { action: "begin", leaseId, focus });
  expect(
    activity.update("review", { action: "renew", leaseId }).focuses,
  ).toEqual([focus]);
  expect(() =>
    activity.update("review", {
      action: "begin",
      leaseId: other,
      focus: { description: "Drafting summary" },
    }),
  ).toThrow(/another session/);
  const next = { description: "Drawing save flow", targetId: "section-2" };
  expect(
    activity.update("review", { action: "renew", leaseId, focus: next })
      .focuses,
  ).toEqual([next]);
  expect(
    activity.update("review", { action: "renew", leaseId, focus: null })
      .focuses,
  ).toBeUndefined();
  activity.update("review", { action: "end", leaseId: other });
  expect(activity.read("review").focuses).toBeUndefined();
  activity.update("review", { action: "renew", leaseId, focus });
  vi.advanceTimersByTime(ACTIVITY_TTL_MS);
  expect(activity.read("review").focuses).toBeUndefined();
  activity.close();
});
