import { randomUUID } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS, ReviewActivity } from "./activity.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { ReviewStore } from "./store.js";

afterEach(() => vi.useRealTimers());

it("renews reported work, expires abandoned work, and does not end another author's activity", () => {
  vi.useFakeTimers();
  const activity = new ReviewActivity();
  const notify = vi.fn<Parameters<ReviewActivity["subscribe"]>[0]>();
  activity.subscribe(notify);

  const a = randomUUID(),
    b = randomUUID();

  const update = (leaseId: string, action: "begin" | "renew" | "end") =>
    activity.update("review", { leaseId, action });

  expect(update(a, "begin").workingCount).toBe(1);
  expect(update(a, "begin").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  update(a, "renew");
  update(b, "begin");
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  expect(activity.read("review").workingCount).toBe(2);
  expect(update(a, "end").workingCount).toBe(1);
  expect(update(a, "end").workingCount).toBe(1);
  vi.advanceTimersByTime(ACTIVITY_TTL_MS / 2);
  expect(activity.read("review")).toEqual({ workingCount: 0, expiresAt: null });
  expect(notify).toHaveBeenLastCalledWith("review");
  expect(() => update(b, "renew")).toThrow(/expired/);
  activity.update("another", { leaseId: randomUUID(), action: "begin" });
  expect(activity.read("review").workingCount).toBe(0);
  activity.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("streams activity separately from document versions and closes the stream on deletion", async () => {
  const store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const api = createReviewApi(store);

  const client = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => api.request(url.replace("/reviews-api", ""), init),
  );

  const command = <Operation>(operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation });

  const { reviewId } = await command({
    type: "create",
    title: "Activity",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  });

  const changed = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>();
  store.subscribe(changed);
  const abort = new AbortController();
  const stream = client.watch(reviewId, abort.signal);

  try {
    expect((await stream.next()).value).toMatchObject({
      activity: { workingCount: 0 },
    });
    const input = { action: "begin", leaseId: randomUUID() };
    await client.post(`/${reviewId}/activity`, input);
    expect((await stream.next()).value).toMatchObject({
      activity: { workingCount: 1 },
    });
    expect(changed).not.toHaveBeenCalled();
    expect(store.history(reviewId)).toHaveLength(1);
    const reconnect = client.watch(reviewId, abort.signal);
    expect((await reconnect.next()).value).toMatchObject({
      activity: { workingCount: 1 },
    });
    await reconnect.return(undefined);
    await command({ type: "delete", reviewId });
    // A reader may already have buffered a pre-deletion snapshot.
    await expect(async () => {
      for await (const _snapshot of stream) {
      }
    }).rejects.toThrow(Error);
    await expect(client.post(`/${reviewId}/activity`, input)).rejects.toThrow(
      /not found/i,
    );
    expect(store.activity.read(reviewId).workingCount).toBe(0);
  } finally {
    abort.abort();
    await store.close();
  }
});
