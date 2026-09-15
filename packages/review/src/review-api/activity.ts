import { z } from "zod";

import { ReviewInputError } from "./document.js";

export const activitySchema = z.strictObject({
  action: z.enum(["begin", "renew", "end"]),
  leaseId: z.uuid(),
});

export interface ActivitySnapshot {
  workingCount: number;
  expiresAt: number | null;
}

// Reported activity expires after a minute without a renewal. This is not a write lock.
export const ACTIVITY_TTL_MS = 60_000;

export class ReviewActivity {
  private readonly reviews = new Map<
    string,
    Map<string, { expiresAt: number; timer: ReturnType<typeof setTimeout> }>
  >();
  private readonly listeners = new Set<(reviewId: string) => void>();
  subscribe(listener: (reviewId: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  read(reviewId: string): ActivitySnapshot {
    const active = [...(this.reviews.get(reviewId)?.values() ?? [])].filter(
      (lease) => lease.expiresAt > Date.now(),
    );

    return {
      workingCount: active.length,
      expiresAt: active.length
        ? Math.max(...active.map((lease) => lease.expiresAt))
        : null,
    };
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Activity boundary: activitySchema.parse below validates incoming JSON.
  update(reviewId: string, value: unknown) {
    const { action, leaseId } = activitySchema.parse(value);
    const leases = this.reviews.get(reviewId) ?? new Map();
    const previous = leases.get(leaseId);

    if (action === "renew" && (!previous || previous.expiresAt <= Date.now()))
      throw new ReviewInputError(
        "Authoring activity expired. Begin a new session.",
        404,
      );

    if (previous) clearTimeout(previous.timer);

    if (action === "end") {
      leases.delete(leaseId);
    } else {
      const expiresAt = Date.now() + ACTIVITY_TTL_MS;

      const timer = setTimeout(
        () => this.update(reviewId, { action: "end", leaseId }),
        ACTIVITY_TTL_MS,
      );

      timer.unref?.();
      leases.set(leaseId, { expiresAt, timer });
    }

    if (leases.size) this.reviews.set(reviewId, leases);
    else this.reviews.delete(reviewId);

    for (const notify of this.listeners) notify(reviewId);

    return this.read(reviewId);
  }
  remove(reviewId: string) {
    for (const lease of this.reviews.get(reviewId)?.values() ?? [])
      clearTimeout(lease.timer);
    this.reviews.delete(reviewId);

    for (const notify of this.listeners) notify(reviewId);
  }
  close() {
    this.listeners.clear();

    for (const reviewId of this.reviews.keys()) this.remove(reviewId);
  }
}
