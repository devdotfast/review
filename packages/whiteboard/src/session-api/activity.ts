import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { SessionInputError } from "./document.js";

const focusSchema = z.strictObject({
  description: z.string().trim().min(1).max(160),
  targetId: z.string().min(1).optional(),
});

/** What a lease covers: the document, or the Diff view's lenses. Each scope
 * has its own exclusive lease, so one agent can write lenses while another
 * writes the document. */
export const leaseScopeSchema = z.enum(["document", "lenses"]);

export type LeaseScope = z.infer<typeof leaseScopeSchema>;

export const activitySchema = z.strictObject({
  action: z.enum(["begin", "renew", "end"]),
  leaseId: z.uuid(),
  scope: leaseScopeSchema
    .optional()
    .describe(
      'What the lease covers. Default "document": review_edit and every other document write. "lenses": review_lens_edit writes only.',
    ),
  focus: focusSchema.nullable().optional(),
});

export type ActivityFocus = z.infer<typeof focusSchema> & {
  /** The lease this focus belongs to; absent means the document's. */
  scope?: LeaseScope;
};

export interface ActivitySnapshot {
  /** Live leases across scopes. */
  workingCount: number;
  /** The latest expiry among live leases. */
  expiresAt: number | null;
  /** The scopes with a live lease, document first. */
  scopes?: LeaseScope[];
  /** Each live lease's focus, document first. */
  focuses?: ActivityFocus[];
}

// The author owns the scope until end or three minutes without an accepted
// write or renewal. A crashed author blocks others for at most this long.
export const ACTIVITY_TTL_MS = 180_000;

const SCOPES = leaseScopeSchema.options;

export class SessionActivity {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly assertWhiteboard?: (sessionId: string) => void,
  ) {
    migrateLeaseScopes(db);

    for (const row of db
      .prepare(
        "SELECT DISTINCT session_id FROM authoring_sessions WHERE expires_at>?",
      )
      .all(Date.now()))
      this.scheduleExpiry(String(row.session_id));
  }
  subscribe(listener: (sessionId: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  private active(sessionId: string, scope: LeaseScope) {
    return this.db
      .prepare(
        "SELECT lease_id,expires_at,focus FROM authoring_sessions WHERE session_id=? AND scope=? AND expires_at>?",
      )
      .get(sessionId, scope, Date.now());
  }

  read(sessionId: string): ActivitySnapshot {
    const live = SCOPES.flatMap((scope) => {
      const active = this.active(sessionId, scope);

      return active ? [{ scope, active }] : [];
    });

    const snapshot: ActivitySnapshot = {
      workingCount: live.length,
      expiresAt: live.length
        ? Math.max(...live.map(({ active }) => Number(active.expires_at)))
        : null,
    };

    if (live.length) snapshot.scopes = live.map(({ scope }) => scope);

    const focuses = live.flatMap(({ scope, active }) =>
      active.focus
        ? [
            {
              ...focusSchema.parse(JSON.parse(String(active.focus))),
              // The document's focus reads as it always has.
              ...(scope !== "document" && { scope }),
            },
          ]
        : [],
    );

    if (focuses.length) snapshot.focuses = focuses;

    return snapshot;
  }

  /** A live lease on `scope` that is not `leaseId`. */
  heldByAnother(
    sessionId: string,
    leaseId?: string,
    scope: LeaseScope = "document",
  ): boolean {
    const active = this.active(sessionId, scope);

    return active !== undefined && active.lease_id !== leaseId;
  }

  /** Recheck inside the write transaction as validation may outlive the lease. */
  assertWrite(
    sessionId: string,
    leaseId?: string,
    scope: LeaseScope = "document",
  ) {
    const active = this.active(sessionId, scope);

    const what =
      scope === "lenses" ? "This review's lenses are" : "This review is";

    if (active && active.lease_id !== leaseId)
      throw new SessionInputError(
        `${what} being authored by another session. Wait for it to finish or expire, then begin your own session.`,
        409,
      );

    if (leaseId && !active)
      throw new SessionInputError(
        scope === "lenses"
          ? 'No live lenses lease. Begin one with review_activity scope:"lenses" and reread the lenses before editing them.'
          : "Authoring session ended or expired. Begin a new session and reread the review before editing.",
        409,
      );
  }
  /** Inside the caller's write transaction, after `assertWrite`: a write
   * under the live lease keeps it alive like a renewal, focus unchanged. It
   * rolls back with the write, so a rejected edit extends nothing. Call
   * `extended` once the transaction commits. */
  extend(
    sessionId: string,
    leaseId?: string,
    scope: LeaseScope = "document",
  ): boolean {
    if (!leaseId) return false;
    const now = Date.now();

    return (
      this.db
        .prepare(
          "UPDATE authoring_sessions SET expires_at=? WHERE session_id=? AND scope=? AND lease_id=? AND expires_at>?",
        )
        .run(now + ACTIVITY_TTL_MS, sessionId, scope, leaseId, now).changes > 0
    );
  }

  /** Move the expiry timer after a committed `extend`. */
  extended(sessionId: string) {
    this.scheduleExpiry(sessionId);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Activity boundary: activitySchema.parse below validates incoming JSON.
  update(sessionId: string, value: unknown) {
    const {
      action,
      leaseId,
      scope = "document",
      focus,
    } = activitySchema.parse(value);

    this.db.exec("BEGIN IMMEDIATE");

    try {
      this.assertWhiteboard?.(sessionId);
      const previous = this.active(sessionId, scope);

      if (action === "end") {
        // Repeated end and attempts to end somebody else's session are harmless.
        this.db
          .prepare(
            "DELETE FROM authoring_sessions WHERE session_id=? AND scope=? AND lease_id=?",
          )
          .run(sessionId, scope, leaseId);
      } else {
        if (previous && previous.lease_id !== leaseId)
          this.assertWrite(sessionId, leaseId, scope);

        if (action === "renew" && !previous)
          throw new SessionInputError(
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
          .prepare(`INSERT INTO authoring_sessions(session_id,scope,lease_id,expires_at,focus) VALUES(?,?,?,?,?)
          ON CONFLICT(session_id,scope) DO UPDATE SET lease_id=excluded.lease_id,expires_at=excluded.expires_at,focus=excluded.focus`)
          .run(
            sessionId,
            scope,
            leaseId,
            Date.now() + ACTIVITY_TTL_MS,
            savedFocus,
          );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.scheduleExpiry(sessionId);

    for (const notify of this.listeners) notify(sessionId);

    return this.read(sessionId);
  }

  /** One timer per review, for its soonest-expiring live lease. */
  private scheduleExpiry(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);

    const next = this.db
      .prepare(
        "SELECT MIN(expires_at) AS expires_at FROM authoring_sessions WHERE session_id=? AND expires_at>?",
      )
      .get(sessionId, Date.now());

    if (next?.expires_at === null || next?.expires_at === undefined) return;

    const timer = setTimeout(
      () => {
        this.scheduleExpiry(sessionId);

        for (const notify of this.listeners) notify(sessionId);
      },
      Math.max(1, Number(next.expires_at) - Date.now()),
    );

    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** Called when another database connection commits session changes. */
  refresh() {
    const ids = new Set(this.timers.keys());

    for (const row of this.db
      .prepare(
        "SELECT DISTINCT session_id FROM authoring_sessions WHERE expires_at>?",
      )
      .all(Date.now()))
      ids.add(String(row.session_id));

    for (const id of ids) {
      this.scheduleExpiry(id);

      for (const notify of this.listeners) notify(id);
    }
  }

  /** The store deletes the session atomically with its review before notifying. */
  deleted(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);

    for (const notify of this.listeners) notify(sessionId);
  }
  close() {
    this.listeners.clear();

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** Leases were once one per review. Rebuild the table keyed by (review,
 * scope), keeping any live lease as the document's. */
function migrateLeaseScopes(db: DatabaseSync) {
  const columns = () =>
    db
      .prepare("PRAGMA table_info(authoring_sessions)")
      .all()
      .map((column) => String(column.name));

  if (columns().includes("scope")) return;

  // Another host on the same home may be migrating too: recheck under lock.
  db.exec("BEGIN IMMEDIATE");

  try {
    const existing = columns();

    if (existing.includes("scope")) {
      db.exec("COMMIT");

      return;
    }

    db.exec(`CREATE TABLE authoring_sessions_scoped(
      session_id TEXT NOT NULL, scope TEXT NOT NULL, lease_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, focus TEXT, PRIMARY KEY(session_id, scope)
    )`);

    if (existing.length)
      db.exec(`INSERT INTO authoring_sessions_scoped(session_id,scope,lease_id,expires_at,focus)
        SELECT session_id,'document',lease_id,expires_at,focus FROM authoring_sessions;
        DROP TABLE authoring_sessions;`);
    db.exec(
      "ALTER TABLE authoring_sessions_scoped RENAME TO authoring_sessions",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
