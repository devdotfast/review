import {
  type HostActivitySnapshot,
  type HostCommand,
  canonicalHostJson,
} from "@dev.fast/review-protocol";

export class ReviewActivityError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_STATE"
      | "RESOURCE_LIMIT"
      | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ReviewActivityError";
  }
}

type ActivityCommand = Extract<
  HostCommand,
  {
    type: "authoring.begin" | "authoring.renew" | "authoring.end";
  }
>;
type Result = { activityId: string; expiresAt: string } | { accepted: true };
interface Session {
  owner: string;
  reviewId: string;
  expiresAt: number;
  state: "working" | "unknown" | "ended";
}

/** Opt-in prototype: bounded, host-lifetime leases and replay receipts only. */
export class ReviewActivity {
  private readonly sessions = new Map<string, Session>();
  private readonly receipts = new Map<
    string,
    { request: string; result: Result }
  >();
  // An admitted activity can always finish, even after routine renewals fill
  // the receipt budget. At most one reserved receipt exists per session.
  private readonly endReceipts = new Map<
    string,
    { request: string; result: Result }
  >();
  private readonly listeners = new Set<(reviewId: string) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      maxSessions?: number;
      maxReceipts?: number;
    } = {},
  ) {}

  command(principalId: string, request: ActivityCommand): Result {
    this.expire();
    const owner = `${principalId}:${request.clientId}`;
    const receiptId = `${owner}:${request.commandId}`;
    const canonical = canonicalHostJson(request);
    const receipt =
      this.receipts.get(receiptId) ?? this.endReceipts.get(receiptId);
    if (receipt) {
      if (receipt.request !== canonical)
        throw new ReviewActivityError(
          "IDEMPOTENCY_CONFLICT",
          "Command ID was already used for another activity request.",
        );
      return receipt.result;
    }
    const { activityId, reviewId } = request.input;
    let session = this.sessions.get(activityId);
    if (session && (session.owner !== owner || session.reviewId !== reviewId))
      throw new ReviewActivityError(
        "NOT_FOUND",
        "Authoring activity not found for this client and review.",
      );
    const full = this.receipts.size >= (this.options.maxReceipts ?? 16_384);
    const reservedEnd =
      full &&
      request.type === "authoring.end" &&
      session &&
      session.state !== "ended";
    // Never evict replay protection or leave a previously admitted session stuck.
    if (full && !reservedEnd)
      throw new ReviewActivityError(
        "RESOURCE_LIMIT",
        "Authoring activity prototype receipt limit reached. Restart the host to reset transient activity.",
      );
    if (request.type === "authoring.begin" && !session) {
      if (this.sessions.size >= (this.options.maxSessions ?? 512))
        throw new ReviewActivityError(
          "RESOURCE_LIMIT",
          "Authoring activity prototype session limit reached. Restart the host to reset transient activity.",
        );
      session = {
        owner,
        reviewId,
        expiresAt: this.deadline(),
        state: "working",
      };
      this.sessions.set(activityId, session);
    } else if (!session) {
      throw new ReviewActivityError(
        "NOT_FOUND",
        "Authoring activity not found.",
      );
    } else if (request.type !== "authoring.end" && session.state === "ended") {
      throw new ReviewActivityError(
        "INVALID_STATE",
        "This authoring activity has ended. Begin with a new activity ID.",
      );
    } else if (request.type === "authoring.renew") {
      session.expiresAt = this.deadline();
      session.state = "working";
    }
    const result: Result =
      request.type === "authoring.end"
        ? { accepted: true }
        : { activityId, expiresAt: new Date(session.expiresAt).toISOString() };
    if (request.type === "authoring.end") session.state = "ended";
    (reservedEnd ? this.endReceipts : this.receipts).set(receiptId, {
      request: canonical,
      result,
    });
    this.schedule();
    this.notify(reviewId);
    return result;
  }

  snapshot(reviewId: string): HostActivitySnapshot {
    this.expire();
    let workingCount = 0;
    let unknownCount = 0;
    for (const session of this.sessions.values()) {
      if (session.reviewId !== reviewId) continue;
      if (session.state === "working") workingCount++;
      if (session.state === "unknown") unknownCount++;
    }
    return {
      reviewId,
      workingCount,
      unknownCount,
    };
  }

  subscribe(listener: (reviewId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    this.sessions.clear();
    this.receipts.clear();
    this.endReceipts.clear();
  }

  private deadline(): number {
    return this.now() + (this.options.leaseMs ?? 60_000);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private expire(): void {
    const changed = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.state === "working" && session.expiresAt <= this.now()) {
        session.state = "unknown";
        changed.add(session.reviewId);
      }
    }
    if (changed.size) this.schedule();
    for (const reviewId of changed) this.notify(reviewId);
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let deadline = Infinity;
    for (const session of this.sessions.values())
      if (session.state === "working")
        deadline = Math.min(deadline, session.expiresAt);
    if (deadline !== Infinity) {
      this.timer = setTimeout(
        () => this.expire(),
        Math.max(1, deadline - this.now()),
      );
      this.timer.unref?.();
    }
  }
  private notify(reviewId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(reviewId);
      } catch {
        /* Observers can read another snapshot. */
      }
    }
  }
}
