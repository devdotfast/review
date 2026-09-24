// Keeps one repeating error from counting as thousands. The budget is per app
// session and per message digest, so a loop on one error still lets other
// errors through, and the burst event says how much was withheld.

export const CLIENT_ERROR_BUDGET_PER_HASH = 5;

const BURST_EVERY = 100;

const DEFAULT_MAX_KEYS = 1_000;

export interface ClientErrorAdmission {
  verdict: "send" | "burst" | "drop";
  /** How many reports past the budget this key has seen, including this one. */
  suppressed: number;
}

export class ClientErrorBudget {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  admit(sessionId: string, messageHash: string): ClientErrorAdmission {
    const key = `${sessionId}\n${messageHash}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, count);

    while (this.counts.size > this.maxKeys) {
      const oldest = this.counts.keys().next().value;

      if (oldest === undefined) break;
      this.counts.delete(oldest);
    }

    const suppressed = Math.max(0, count - CLIENT_ERROR_BUDGET_PER_HASH);

    if (suppressed === 0) return { verdict: "send", suppressed };

    return {
      verdict:
        suppressed === 1 || suppressed % BURST_EVERY === 0 ? "burst" : "drop",
      suppressed,
    };
  }
}
