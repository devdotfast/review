import { randomUUID } from "node:crypto";

import { HostCommandSchema } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewActivity } from "./review-activity";

const active: ReviewActivity[] = [];
afterEach(() => {
  for (const activity of active.splice(0)) activity.close();
  vi.useRealTimers();
});

function fixture(
  options: ConstructorParameters<typeof ReviewActivity>[0] = {},
) {
  const activity = new ReviewActivity(options);
  active.push(activity);
  const reviewId = randomUUID();
  const activityId = randomUUID();
  const principalId = randomUUID();
  const envelope = {
    apiVersion: 1,
    hostId: randomUUID(),
    workspaceId: randomUUID(),
    clientId: randomUUID(),
  };
  const command = (
    type: "authoring.begin" | "authoring.renew" | "authoring.end",
    overrides = {},
  ) => {
    const request = HostCommandSchema.parse({
      ...envelope,
      type,
      commandId: randomUUID(),
      input: { reviewId, activityId },
      ...overrides,
    });
    if (
      request.type !== "authoring.begin" &&
      request.type !== "authoring.renew" &&
      request.type !== "authoring.end"
    )
      throw new Error("Expected activity command");
    return request;
  };
  return { activity, reviewId, activityId, principalId, command };
}

describe("transient authoring activity", () => {
  it("can end an admitted activity after renewals exhaust routine receipts", () => {
    const f = fixture({ maxReceipts: 2, maxSessions: 1 });
    f.activity.command(f.principalId, f.command("authoring.begin"));
    f.activity.command(f.principalId, f.command("authoring.renew"));
    expect(() =>
      f.activity.command(f.principalId, f.command("authoring.renew")),
    ).toThrow(/receipt limit/);
    const end = f.command("authoring.end");
    expect(f.activity.command(f.principalId, end)).toEqual({ accepted: true });
    expect(f.activity.snapshot(f.reviewId)).toMatchObject({
      workingCount: 0,
      unknownCount: 0,
    });
    expect(f.activity.command(f.principalId, end)).toEqual({ accepted: true });
    expect(() =>
      f.activity.command(f.principalId, f.command("authoring.end")),
    ).toThrow(/receipt limit/);
  });
  it("notifies at lease expiry, reports unknown, and clears only explicitly ended activity", () => {
    vi.useFakeTimers();
    const f = fixture();
    const observed: unknown[] = [];
    f.activity.subscribe((id) => observed.push(f.activity.snapshot(id)));
    f.activity.command(f.principalId, f.command("authoring.begin"));
    expect(f.activity.snapshot(f.reviewId)).toMatchObject({
      workingCount: 1,
      unknownCount: 0,
    });
    vi.advanceTimersByTime(60_000);
    expect(observed.at(-1)).toMatchObject({ workingCount: 0, unknownCount: 1 });
    f.activity.command(f.principalId, f.command("authoring.renew"));
    expect(f.activity.snapshot(f.reviewId)).toMatchObject({
      workingCount: 1,
      unknownCount: 0,
    });
    f.activity.command(f.principalId, f.command("authoring.end"));
    expect(f.activity.snapshot(f.reviewId)).toMatchObject({
      workingCount: 0,
      unknownCount: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaying begin or renew never refreshes an expired lease or resurrects an ended session", () => {
    vi.useFakeTimers();
    const f = fixture();
    const begin = f.command("authoring.begin");
    const first = f.activity.command(f.principalId, begin);
    vi.advanceTimersByTime(10_000);
    const renew = f.command("authoring.renew");
    const renewed = f.activity.command(f.principalId, renew);
    vi.advanceTimersByTime(60_000);
    expect(f.activity.command(f.principalId, begin)).toEqual(first);
    expect(f.activity.command(f.principalId, renew)).toEqual(renewed);
    expect(f.activity.snapshot(f.reviewId).unknownCount).toBe(1);
    f.activity.command(f.principalId, f.command("authoring.end"));
    expect(f.activity.command(f.principalId, begin)).toEqual(first);
    expect(f.activity.command(f.principalId, renew)).toEqual(renewed);
    expect(f.activity.snapshot(f.reviewId).workingCount).toBe(0);
    expect(() =>
      f.activity.command(f.principalId, f.command("authoring.renew")),
    ).toThrow(/ended/);
    expect(() =>
      f.activity.command(f.principalId, f.command("authoring.begin")),
    ).toThrow(/ended/);
  });

  it("binds each identity to its principal, client, and review and detects command reuse", () => {
    const f = fixture();
    const begin = f.command("authoring.begin");
    f.activity.command(f.principalId, begin);
    expect(() =>
      f.activity.command(randomUUID(), f.command("authoring.end")),
    ).toThrow(/not found/);
    expect(() =>
      f.activity.command(
        f.principalId,
        f.command("authoring.end", { clientId: randomUUID() }),
      ),
    ).toThrow(/not found/);
    expect(() =>
      f.activity.command(
        f.principalId,
        f.command("authoring.end", {
          input: { activityId: f.activityId, reviewId: randomUUID() },
        }),
      ),
    ).toThrow(/not found/);
    expect(() =>
      f.activity.command(
        f.principalId,
        f.command("authoring.end", { commandId: begin.commandId }),
      ),
    ).toThrow(/Command ID/);
    expect(f.activity.snapshot(f.reviewId).workingCount).toBe(1);
  });

  it("aggregates independent sessions without one ending another", () => {
    const f = fixture();
    f.activity.command(f.principalId, f.command("authoring.begin"));
    f.activity.command(
      randomUUID(),
      f.command("authoring.begin", {
        input: { reviewId: f.reviewId, activityId: randomUUID() },
      }),
    );
    expect(f.activity.snapshot(f.reviewId).workingCount).toBe(2);
    f.activity.command(f.principalId, f.command("authoring.end"));
    expect(f.activity.snapshot(f.reviewId).workingCount).toBe(1);
  });

  it("bounds memory without evicting replay protection and disposes expiry timers", () => {
    vi.useFakeTimers();
    const f = fixture({ maxReceipts: 2, maxSessions: 1 });
    const begin = f.command("authoring.begin");
    f.activity.command(f.principalId, begin);
    expect(() =>
      f.activity.command(
        f.principalId,
        f.command("authoring.begin", {
          input: { reviewId: f.reviewId, activityId: randomUUID() },
        }),
      ),
    ).toThrow(/session limit/);
    f.activity.command(f.principalId, f.command("authoring.end"));
    expect(() =>
      f.activity.command(f.principalId, f.command("authoring.end")),
    ).toThrow(/receipt limit/);
    f.activity.command(f.principalId, begin);
    expect(f.activity.snapshot(f.reviewId).workingCount).toBe(0);
    f.activity.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
