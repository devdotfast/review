import type { StructuralDiffEvent } from "@dev.fast/review-protocol";

import {
  type StructuralDiffRequest,
  structuralDiff,
} from "./structural-diff.js";

/** Replays a pinned comparison to concurrent rendering and coverage consumers. */
export class StructuralComparisons {
  private readonly entries = new Map<string, Comparison>();

  async *stream(
    input: StructuralDiffRequest,
  ): AsyncGenerator<StructuralDiffEvent> {
    input.signal.throwIfAborted();

    const key = JSON.stringify([
      configGeneration,
      input.repositoryPath,
      input.comparison,
      input.paths,
    ]);

    let entry = this.entries.get(key);

    if (!entry) {
      entry = new Comparison(input);
      this.entries.set(key, entry);
    }

    entry.readers++;

    try {
      yield* entry.read(input.signal);
    } finally {
      entry.readers--;

      if ((!entry.done && !entry.readers) || entry.error || entry.failed) {
        entry.abort.abort();
        this.entries.delete(key);
      }
      // Keep at most two completed streams (each is bounded by the transport).

      const idle = [...this.entries].filter(
        ([, value]) => value.done && !value.readers,
      );

      for (const [oldKey] of idle.slice(0, -2)) this.entries.delete(oldKey);
    }
  }

  close(): void {
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
  }
}

let configGeneration = 0;

export function invalidateStructuralComparisons(): void {
  configGeneration++;
}

class Comparison {
  readonly abort = new AbortController();
  readonly events: StructuralDiffEvent[] = [];
  readers = 0;
  done = false;
  error: unknown;
  failed = false;
  private readonly listeners = new Set<() => void>();

  constructor(input: StructuralDiffRequest) {
    void this.run(input);
  }

  private async run(input: StructuralDiffRequest): Promise<void> {
    try {
      for await (const event of structuralDiff({
        ...input,
        signal: this.abort.signal,
      })) {
        if (event.type === "complete")
          this.failed = event.failed > 0 || !!event.aborted;
        this.events.push(event);

        for (const wake of this.listeners) wake();
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.done = true;

      for (const wake of this.listeners) wake();
    }
  }

  async *read(signal: AbortSignal): AsyncGenerator<StructuralDiffEvent> {
    let index = 0;

    while (true) {
      signal.throwIfAborted();

      if (index < this.events.length) {
        yield this.events[index++];
        continue;
      }

      if (this.done) {
        if (this.error) throw this.error;

        return;
      }

      await new Promise<void>((resolve) => {
        const wake = () => {
          this.listeners.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };

        this.listeners.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
}
