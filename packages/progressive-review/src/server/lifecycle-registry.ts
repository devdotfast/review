import type { ReviewSessionLifecycleEvent } from "@dev.fast/review-protocol";

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

export interface ReviewLifecycleRecord {
  id: number;
  at: number;
  value: ReviewSessionLifecycleEvent;
}

export class ReviewLifecycleRegistry {
  private sequence = 0;
  private readonly records = new Map<string, ReviewLifecycleRecord[]>();
  private readonly listeners = new Map<
    string,
    Set<(record: ReviewLifecycleRecord) => void>
  >();

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {}

  append(value: ReviewSessionLifecycleEvent): ReviewLifecycleRecord {
    const record = { id: ++this.sequence, at: this.now(), value };
    const sessionRecords = this.records.get(value.sessionId) ?? [];
    sessionRecords.push(record);
    this.records.set(value.sessionId, sessionRecords);
    this.prune();
    for (const listener of this.listeners.get(value.sessionId) ?? []) {
      listener(record);
    }
    return record;
  }

  history(sessionId: string, afterId = 0): ReviewLifecycleRecord[] {
    this.prune();
    return (this.records.get(sessionId) ?? []).filter(
      (record) => record.id > afterId,
    );
  }

  subscribe(
    sessionId: string,
    listener: (record: ReviewLifecycleRecord) => void,
  ): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  terminal(sessionId: string): ReviewSessionLifecycleEvent | undefined {
    const records = this.history(sessionId);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const event = records[index].value;
      if (
        event.event === "submitted" ||
        event.event === "dismissed" ||
        event.event === "error"
      ) {
        return event;
      }
    }
    return undefined;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [sessionId, records] of this.records) {
      const firstRetained = records.findIndex((record) => record.at >= cutoff);
      if (firstRetained < 0) {
        this.records.delete(sessionId);
      } else if (firstRetained > 0) {
        records.splice(0, firstRetained);
      }
    }
  }
}
