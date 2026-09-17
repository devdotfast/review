import { z } from "zod";

import { ReviewInputError } from "./document.js";

const focusSchema = z.strictObject({
  description: z.string().trim().min(1).max(160),
  targetId: z.string().min(1).optional(),
});

export const activitySchema = z.strictObject({
  action: z.enum(["begin", "renew", "end"]),
  leaseId: z.uuid(),
  focus: focusSchema.nullable().optional(),
});

export interface ActivitySnapshot {
  workingCount: number;
  expiresAt: number | null;
  focuses?: z.infer<typeof focusSchema>[];
}

// Reported activity expires after a minute without a renewal. This is not a write lock.
export const ACTIVITY_TTL_MS = 60_000;

export class ReviewActivity {
  private readonly reviews = new Map<
    string,
    Map<
      string,
      {
        expiresAt: number;
        timer: ReturnType<typeof setTimeout>;
        focus?: z.infer<typeof focusSchema>;
      }
    >
  >();
  private readonly listeners = new Set<(reviewId: string) => void>();
  subscribe(listener: (reviewId: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  // Liveness follows the expiry timer alone. Timers pause with the system clock
  // during sleep, so comparing expiresAt against Date.now() here would let
  // read() and the notified stream disagree until the timer fires.
  read(reviewId: string): ActivitySnapshot {
    const active = [...(this.reviews.get(reviewId)?.values() ?? [])];

    const focuses = active.flatMap((lease) =>
      lease.focus ? [lease.focus] : [],
    );

    const snapshot: ActivitySnapshot = {
      workingCount: active.length,
      expiresAt: active.length
        ? Math.max(...active.map((lease) => lease.expiresAt))
        : null,
    };

    if (focuses.length) snapshot.focuses = focuses;

    return snapshot;
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Activity boundary: activitySchema.parse below validates incoming JSON.
  update(reviewId: string, value: unknown) {
    const { action, leaseId, focus } = activitySchema.parse(value);
    const leases = this.reviews.get(reviewId) ?? new Map();
    const previous = leases.get(leaseId);

    if (action === "renew" && !previous)
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
      leases.set(leaseId, {
        expiresAt,
        timer,
        focus: focus === undefined ? previous?.focus : (focus ?? undefined),
      });
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
