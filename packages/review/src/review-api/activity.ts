import type { DatabaseSync } from "node:sqlite";

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

// The author owns the review until end or three minutes without an accepted
// write or renewal. A crashed author blocks others for at most this long.
export const ACTIVITY_TTL_MS = 180_000;

export class ReviewActivity {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(reviewId: string) => void>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly assertReview?: (reviewId: string) => void,
    private readonly assertAvailable?: (reviewId: string) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS authoring_sessions(
      review_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, focus TEXT
    )`);

    for (const row of db
      .prepare("SELECT review_id FROM authoring_sessions WHERE expires_at>?")
      .all(Date.now()))
      this.scheduleExpiry(String(row.review_id));
  }
  subscribe(listener: (reviewId: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  private active(reviewId: string) {
    return this.db
      .prepare(
        "SELECT lease_id,expires_at,focus FROM authoring_sessions WHERE review_id=? AND expires_at>?",
      )
      .get(reviewId, Date.now());
  }

  read(reviewId: string): ActivitySnapshot {
    const active = this.active(reviewId);

    const snapshot: ActivitySnapshot = {
      workingCount: active ? 1 : 0,
      expiresAt: active ? Number(active.expires_at) : null,
    };

    if (active?.focus)
      snapshot.focuses = [focusSchema.parse(JSON.parse(String(active.focus)))];

    return snapshot;
  }

  /** A live lease that is not `leaseId`. */
  heldByAnother(reviewId: string, leaseId?: string): boolean {
    const active = this.active(reviewId);

    return active !== undefined && active.lease_id !== leaseId;
  }

  /** Recheck inside the write transaction as validation may outlive the lease. */
  assertWrite(reviewId: string, leaseId?: string) {
    const active = this.active(reviewId);

    if (active && active.lease_id !== leaseId)
      throw new ReviewInputError(
        "This review is being authored by another session. Wait for it to finish or expire, then begin your own session.",
        409,
      );

    if (leaseId && !active)
      throw new ReviewInputError(
        "Authoring session ended or expired. Begin a new session and reread the review before editing.",
        409,
      );
  }
  /** Inside the caller's write transaction, after `assertWrite`: a write
   * under the live lease keeps it alive like a renewal, focus unchanged. It
   * rolls back with the write, so a rejected edit extends nothing. Call
   * `extended` once the transaction commits. */
  extend(reviewId: string, leaseId?: string): boolean {
    if (!leaseId) return false;
    const now = Date.now();

    return (
      this.db
        .prepare(
          "UPDATE authoring_sessions SET expires_at=? WHERE review_id=? AND lease_id=? AND expires_at>?",
        )
        .run(now + ACTIVITY_TTL_MS, reviewId, leaseId, now).changes > 0
    );
  }

  /** Move the expiry timer after a committed `extend`. */
  extended(reviewId: string) {
    this.scheduleExpiry(reviewId);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Activity boundary: activitySchema.parse below validates incoming JSON.
  update(reviewId: string, value: unknown) {
    const { action, leaseId, focus } = activitySchema.parse(value);
    this.db.exec("BEGIN IMMEDIATE");

    try {
      this.assertReview?.(reviewId);

      if (action !== "end") this.assertAvailable?.(reviewId);
      const previous = this.active(reviewId);

      if (action === "end") {
        // Repeated end and attempts to end somebody else's session are harmless.
        this.db
          .prepare(
            "DELETE FROM authoring_sessions WHERE review_id=? AND lease_id=?",
          )
          .run(reviewId, leaseId);
      } else {
        if (previous && previous.lease_id !== leaseId)
          this.assertWrite(reviewId, leaseId);

        if (action === "renew" && !previous)
          throw new ReviewInputError(
            "Authoring session expired. Begin a new session.",
            409,
          );

        const savedFocus =
          focus === undefined
            ? (previous?.focus ?? null)
            : focus === null
              ? null
              : JSON.stringify(focus);

        this.db
          .prepare(`INSERT INTO authoring_sessions VALUES(?,?,?,?)
          ON CONFLICT(review_id) DO UPDATE SET lease_id=excluded.lease_id,expires_at=excluded.expires_at,focus=excluded.focus`)
          .run(reviewId, leaseId, Date.now() + ACTIVITY_TTL_MS, savedFocus);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.scheduleExpiry(reviewId);

    for (const notify of this.listeners) notify(reviewId);

    return this.read(reviewId);
  }

  private scheduleExpiry(reviewId: string) {
    clearTimeout(this.timers.get(reviewId));
    this.timers.delete(reviewId);
    const active = this.active(reviewId);

    if (!active) return;

    const timer = setTimeout(
      () => {
        this.scheduleExpiry(reviewId);

        for (const notify of this.listeners) notify(reviewId);
      },
      Math.max(1, Number(active.expires_at) - Date.now()),
    );

    timer.unref?.();
    this.timers.set(reviewId, timer);
  }

  /** Called when another database connection commits session changes. */
  refresh() {
    const ids = new Set(this.timers.keys());

    for (const row of this.db
      .prepare("SELECT review_id FROM authoring_sessions WHERE expires_at>?")
      .all(Date.now()))
      ids.add(String(row.review_id));

    for (const id of ids) {
      this.scheduleExpiry(id);

      for (const notify of this.listeners) notify(id);
    }
  }

  /** The store deletes the session atomically with its review before notifying. */
  deleted(reviewId: string) {
    clearTimeout(this.timers.get(reviewId));
    this.timers.delete(reviewId);

    for (const notify of this.listeners) notify(reviewId);
  }
  close() {
    this.listeners.clear();

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
